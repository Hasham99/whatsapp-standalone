# WhatsApp Platform — Flutter Integration Guide

> **Use-case**: One Flutter app (`Bookable`) where multiple **admin users** each link their own
> WhatsApp account. The platform issues every admin a dedicated *slot* (child app) they scan
> once. After that, messages are sent through their linked WhatsApp from anywhere in the app.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Base URL & Headers](#2-base-url--headers)
3. [Auth — Access & Refresh Tokens](#3-auth--access--refresh-tokens)
4. [Slot Management](#4-slot-management)
5. [WhatsApp Lifecycle — REST Triggers](#5-whatsapp-lifecycle--rest-triggers)
6. [Socket.IO Events Reference](#6-socketio-events-reference)
7. [Sending Messages](#7-sending-messages)
8. [Complete Dart Implementation](#8-complete-dart-implementation)
9. [QR Screen Widget](#9-qr-screen-widget)
10. [Error Handling](#10-error-handling)
11. [pubspec.yaml Dependencies](#11-pubspecyaml-dependencies)

---

## 1. Architecture Overview

```
Bookable App (Flutter)
      │
      │  API Key of "Bookable" master app
      │
      ▼
WhatsApp Platform
      │
      ├── POST /webhook/:masterAppId/slots   ← register each admin user once
      │         returns { slotId, apiKey }
      │
      └── Each slot is an independent WhatsApp connection
               ├── POST /webhook/:slotId/init      ← start QR generation
               ├── Socket wa_qr_{slotId}           ← receive QR image
               ├── Socket wa_ready_{slotId}        ← WhatsApp linked!
               └── POST /webhook/:slotId/send      ← send messages
```

**Key points**:
- The **master app API key** is a server-side secret you embed in your Flutter app (or backend).
- Each admin user gets their own **slot ID + slot API key** stored in your database.
- Slot creation is **idempotent** — calling it again with the same `adminId` returns the existing slot.

---

## 2. Base URL & Headers

```
Base URL:  https://your-server.com        (or http://localhost:3500 for dev)
```

### Headers by endpoint type

| Endpoint type | Required header |
|---|---|
| Auth endpoints (`/api/*`) | `x-auth-token: <accessToken>` |
| Slot / webhook endpoints  | `x-api-key: <masterAppApiKey>` |
| Slot send / init / health | `x-api-key: <slotApiKey>` |

---

## 3. Auth — Access & Refresh Tokens

The platform uses **JWT tokens**.

| Token | Lifetime | Purpose |
|---|---|---|
| `accessToken` | 1 hour | Authenticate API requests via `x-auth-token` |
| `refreshToken` | 30 days | Exchange for a new token pair via `/api/auth/refresh` |

### 3.1 Login

```
POST /api/login
Content-Type: application/json

Body:
{
  "username": "admin",       // or email address
  "password": "admin123"
}

Response 200:
{
  "accessToken":  "eyJhbGci...",
  "refreshToken": "eyJhbGci...",
  "username":     "admin",
  "name":         "Administrator",
  "role":         "admin"           // "admin" | "user"
}

Response 401:
{ "error": "Invalid credentials" }
```

### 3.2 Refresh Access Token

Call this automatically when any request returns `401`.

```
POST /api/auth/refresh
Content-Type: application/json

Body:
{
  "refreshToken": "eyJhbGci..."
}

Response 200:
{
  "accessToken":  "eyJhbGci...",   // new pair — store both
  "refreshToken": "eyJhbGci...",
  "username":     "admin",
  "name":         "Administrator",
  "role":         "admin"
}

Response 401:
{ "error": "Refresh token expired or invalid" }
→ User must log in again
```

### 3.3 Logout

```
POST /api/logout
x-auth-token: <accessToken>
Content-Type: application/json

Body:
{
  "refreshToken": "eyJhbGci..."
}

Response 200:
{ "success": true }
```

### 3.4 Sign Up (new user)

```
POST /api/signup
Content-Type: application/json

Body:
{
  "username": "john",
  "name":     "John Doe",
  "email":    "john@example.com",
  "password": "secret"
}

Response 200:
{
  "accessToken":  "eyJhbGci...",
  "refreshToken": "eyJhbGci...",
  "username":     "john",
  "name":         "John Doe",
  "role":         "user"
}
```

### 3.5 Get current user

```
GET /api/me
x-auth-token: <accessToken>

Response 200:
{
  "username": "admin",
  "name":     "Administrator",
  "email":    "admin@platform.local",
  "role":     "admin"
}
```

---

## 4. Slot Management

> All slot endpoints use `x-api-key: <masterAppApiKey>` — **not** an access token.
> The master app API key lives on your server, never in the Flutter APK.

### 4.1 Create / get slot for an admin user

Idempotent — safe to call on every app launch for a given `adminId`.

```
POST /webhook/:masterAppId/slots
x-api-key: <masterAppApiKey>
Content-Type: application/json

Body:
{
  "adminId": "user_42"    // any unique string identifying the admin user
}

Response 200:
{
  "slotId":  "a3f1c2d4",
  "apiKey":  "sk-...",
  "adminId": "user_42",
  "status":  "DISCONNECTED"   // DISCONNECTED | INITIALIZING | READY
}
```

Store `slotId` and `apiKey` in your database keyed by `adminId`. Never expose them to end-users.

### 4.2 List all slots

```
GET /webhook/:masterAppId/slots
x-api-key: <masterAppApiKey>

Response 200:
[
  {
    "slotId":    "a3f1c2d4",
    "adminId":   "user_42",
    "status":    "READY",
    "createdAt": "2026-04-01T08:00:00.000Z"
  }
]
```

### 4.3 Delete a slot

Disconnects WhatsApp and removes the session.

```
DELETE /webhook/:masterAppId/slots/:slotId
x-api-key: <masterAppApiKey>

Response 200:
{ "success": true }
```

---

## 5. WhatsApp Lifecycle — REST Triggers

> These endpoints use `x-api-key: <slotApiKey>` for the individual slot.

### 5.1 Initialize (start QR generation)

Call this after the admin taps "Connect WhatsApp".

```
POST /webhook/:slotId/init
x-api-key: <slotApiKey>

Response 200:
{ "success": true, "status": "INITIALIZING" }
// or "ALREADY_READY" if already linked
```

After calling init, listen to socket events (see section 6) for the QR and ready notifications.

### 5.2 Health check

```
GET /webhook/:slotId/health
x-api-key: <slotApiKey>

Response 200:
{
  "appId":  "a3f1c2d4",
  "name":   "Bookable__user_42",
  "status": "READY"          // DISCONNECTED | INITIALIZING | READY
}
```

---

## 6. Socket.IO Events Reference

Use the [`socket_io_client`](https://pub.dev/packages/socket_io_client) Flutter package.

### 6.1 Connect & authenticate

```dart
final socket = io('https://your-server.com', OptionBuilder()
  .setTransports(['websocket'])
  .disableAutoConnect()
  .build());

socket.connect();

// Authenticate with the slot's API key
socket.emit('subscribe_external', {
  'apiKey': slotApiKey,
  'appId':  slotId,
});
```

### 6.2 Outbound events (Flutter → Server)

| Event | Payload | Description |
|---|---|---|
| `subscribe_external` | `{ apiKey, appId }` | Authenticate and join the slot's room |

### 6.3 Inbound events (Server → Flutter)

| Event | Payload | When fired |
|---|---|---|
| `auth_error` | `{ error }` | Invalid API key supplied |
| `wa_status_{slotId}` | `{ status, hasQR }` | Sent immediately after `subscribe_external` — current state |
| `wa_qr_{slotId}` | `{ qr }` | QR data URL (`data:image/png;base64,...`). Fires every ~20 s until scanned |
| `wa_authenticated_{slotId}` | _(none)_ | QR was scanned — WhatsApp is authenticating |
| `wa_ready_{slotId}` | `{ number, name }` | WhatsApp fully linked and ready to send |
| `wa_disconnected_{slotId}` | `{ reason }` | WhatsApp disconnected (logout / network) |
| `wa_error_{slotId}` | `{ message }` | Auth failure or fatal WhatsApp error |
| `recurring_fired_{slotId}` | `{ id, log }` | A recurring schedule fired (if used) |

### 6.4 Connection flow

```
Flutter                           Server
  │                                  │
  │── connect() ───────────────────► │
  │── subscribe_external ──────────► │
  │                                  │── sends wa_status_* immediately
  │◄── wa_status_{id}: DISCONNECTED  │
  │                                  │
  │── POST /webhook/:id/init ───────►│
  │                                  │── Chromium starts, WhatsApp Web loads
  │◄── wa_qr_{id}: { qr: "data:..." }│  (new QR every ~20 s until scanned)
  │  [display QR to admin]           │
  │                                  │
  │  [admin scans with phone]        │
  │◄── wa_authenticated_{id}         │
  │◄── wa_ready_{id}: {number, name} │
  │  [show Connected UI]             │
```

---

## 7. Sending Messages

```
POST /webhook/:slotId/send
x-api-key: <slotApiKey>
Content-Type: application/json

Body:
{
  "number":  "923001234567",    // international format, digits only
  "message": "Your booking is confirmed!"
}

Response 200:
{ "success": true }

Response 503:
{ "success": false, "error": "WhatsApp not ready (status: DISCONNECTED)" }
```

---

## 8. Complete Dart Implementation

### 8.1 Token storage helper

```dart
import 'package:shared_preferences/shared_preferences.dart';

class TokenStore {
  static const _access  = 'wa_access_token';
  static const _refresh = 'wa_refresh_token';

  static Future<void> save(String access, String refresh) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_access,  access);
    await p.setString(_refresh, refresh);
  }

  static Future<String?> getAccess()  async =>
      (await SharedPreferences.getInstance()).getString(_access);

  static Future<String?> getRefresh() async =>
      (await SharedPreferences.getInstance()).getString(_refresh);

  static Future<void> clear() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_access);
    await p.remove(_refresh);
  }
}
```

### 8.2 AuthService

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class UnauthorizedException implements Exception {}

class AuthService {
  final String baseUrl;
  String? _accessToken;
  String? _refreshToken;

  AuthService(this.baseUrl);

  // Call once on app start to restore saved session
  Future<void> loadTokens() async {
    _accessToken  = await TokenStore.getAccess();
    _refreshToken = await TokenStore.getRefresh();
  }

  bool get isLoggedIn => _accessToken != null;
  String? get accessToken => _accessToken;

  Future<Map<String, dynamic>> login(String usernameOrEmail, String password) async {
    final res = await http.post(
      Uri.parse('$baseUrl/api/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'username': usernameOrEmail, 'password': password}),
    );
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) throw Exception(data['error'] ?? 'Login failed');
    await _storeTokens(data);
    return data;
  }

  Future<Map<String, dynamic>> signUp({
    required String username,
    required String name,
    required String email,
    required String password,
  }) async {
    final res = await http.post(
      Uri.parse('$baseUrl/api/signup'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'username': username,
        'name':     name,
        'email':    email,
        'password': password,
      }),
    );
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) throw Exception(data['error'] ?? 'Signup failed');
    await _storeTokens(data);
    return data;
  }

  Future<void> logout() async {
    try {
      await authedRequest('POST', '/api/logout', body: {'refreshToken': _refreshToken});
    } catch (_) {}
    _accessToken = null;
    _refreshToken = null;
    await TokenStore.clear();
  }

  // ── Token refresh ──────────────────────────────────────────────────────────

  Future<void> _storeTokens(Map<String, dynamic> data) async {
    _accessToken  = data['accessToken']  as String;
    _refreshToken = data['refreshToken'] as String;
    await TokenStore.save(_accessToken!, _refreshToken!);
  }

  Future<bool> _tryRefresh() async {
    if (_refreshToken == null) return false;
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refreshToken': _refreshToken}),
      );
      if (res.statusCode != 200) return false;
      await _storeTokens(jsonDecode(res.body) as Map<String, dynamic>);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── Authenticated HTTP helper with auto-refresh on 401 ────────────────────

  Future<http.Response> authedRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool retried = false,
  }) async {
    final uri     = Uri.parse('$baseUrl$path');
    final headers = {
      'Content-Type': 'application/json',
      'x-auth-token': _accessToken ?? '',
    };
    final encoded = body != null ? jsonEncode(body) : null;

    final http.Response res;
    switch (method.toUpperCase()) {
      case 'POST':
        res = await http.post(uri, headers: headers, body: encoded);
        break;
      case 'PUT':
        res = await http.put(uri, headers: headers, body: encoded);
        break;
      case 'DELETE':
        res = await http.delete(uri, headers: headers);
        break;
      default:
        res = await http.get(uri, headers: headers);
    }

    if (res.statusCode == 401 && !retried) {
      if (await _tryRefresh()) {
        return authedRequest(method, path, body: body, retried: true);
      }
      throw UnauthorizedException();
    }
    return res;
  }
}
```

### 8.3 WhatsAppService

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:socket_io_client/socket_io_client.dart' as sio;

class WhatsAppService {
  final String baseUrl;
  final String masterAppId;
  final String masterApiKey;

  WhatsAppService({
    required this.baseUrl,
    required this.masterAppId,
    required this.masterApiKey,
  });

  // ── Slot Management ────────────────────────────────────────────────────────

  /// Idempotent — safe to call every time an admin opens the app.
  Future<Map<String, dynamic>> getOrCreateSlot(String adminId) async {
    final res = await http.post(
      Uri.parse('$baseUrl/webhook/$masterAppId/slots'),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': masterApiKey,
      },
      body: jsonEncode({'adminId': adminId}),
    );
    if (res.statusCode != 200) throw Exception('Slot error: ${res.body}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<List<Map<String, dynamic>>> listSlots() async {
    final res = await http.get(
      Uri.parse('$baseUrl/webhook/$masterAppId/slots'),
      headers: {'x-api-key': masterApiKey},
    );
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  Future<void> deleteSlot(String slotId) async {
    await http.delete(
      Uri.parse('$baseUrl/webhook/$masterAppId/slots/$slotId'),
      headers: {'x-api-key': masterApiKey},
    );
  }

  // ── WhatsApp Lifecycle ─────────────────────────────────────────────────────

  /// Triggers QR generation. Connect socket first to receive wa_qr_* event.
  Future<String> initSlot(String slotId, String slotApiKey) async {
    final res = await http.post(
      Uri.parse('$baseUrl/webhook/$slotId/init'),
      headers: {'x-api-key': slotApiKey},
    );
    return (jsonDecode(res.body) as Map<String, dynamic>)['status'] as String;
  }

  Future<Map<String, dynamic>> checkHealth(String slotId, String slotApiKey) async {
    final res = await http.get(
      Uri.parse('$baseUrl/webhook/$slotId/health'),
      headers: {'x-api-key': slotApiKey},
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  Future<void> sendMessage(
    String slotId,
    String slotApiKey,
    String number,
    String message,
  ) async {
    final res = await http.post(
      Uri.parse('$baseUrl/webhook/$slotId/send'),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': slotApiKey,
      },
      body: jsonEncode({'number': number, 'message': message}),
    );
    if (res.statusCode != 200) {
      final err = (jsonDecode(res.body) as Map)['error'] ?? 'Send failed';
      throw Exception(err);
    }
  }

  // ── Socket ─────────────────────────────────────────────────────────────────

  /// Returns a connected socket subscribed to the slot's room.
  sio.Socket connectSocket(String slotId, String slotApiKey) {
    final socket = sio.io(
      baseUrl,
      sio.OptionBuilder()
        .setTransports(['websocket'])
        .disableAutoConnect()
        .build(),
    );

    socket.connect();

    socket.onConnect((_) {
      socket.emit('subscribe_external', {
        'apiKey': slotApiKey,
        'appId':  slotId,
      });
    });

    // Re-subscribe after reconnect
    socket.onReconnect((_) {
      socket.emit('subscribe_external', {
        'apiKey': slotApiKey,
        'appId':  slotId,
      });
    });

    return socket;
  }
}
```

---

## 9. QR Screen Widget

```dart
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:socket_io_client/socket_io_client.dart' as sio;

class WhatsAppConnectScreen extends StatefulWidget {
  final String            slotId;
  final String            slotApiKey;
  final WhatsAppService   service;
  final VoidCallback      onConnected;

  const WhatsAppConnectScreen({
    super.key,
    required this.slotId,
    required this.slotApiKey,
    required this.service,
    required this.onConnected,
  });

  @override
  State<WhatsAppConnectScreen> createState() => _State();
}

class _State extends State<WhatsAppConnectScreen> {
  sio.Socket? _socket;
  Uint8List?  _qrBytes;
  String      _status  = 'DISCONNECTED';
  String      _info    = '';
  bool        _loading = false;

  @override
  void initState() {
    super.initState();
    _initSocket();
    _checkExistingStatus();
  }

  @override
  void dispose() {
    _socket?.dispose();
    super.dispose();
  }

  // Check current status without starting a new connection
  Future<void> _checkExistingStatus() async {
    try {
      final h = await widget.service.checkHealth(widget.slotId, widget.slotApiKey);
      if (mounted) setState(() => _status = h['status'] as String);
      if (_status == 'READY') widget.onConnected();
    } catch (_) {}
  }

  void _initSocket() {
    _socket = widget.service.connectSocket(widget.slotId, widget.slotApiKey);
    final id = widget.slotId;

    _socket!.on('wa_status_$id', (data) {
      if (!mounted) return;
      setState(() { _status = data['status'] as String; });
      if (_status == 'READY') widget.onConnected();
    });

    _socket!.on('wa_qr_$id', (data) {
      if (!mounted) return;
      // data['qr'] = "data:image/png;base64,<base64>"
      final b64   = (data['qr'] as String).split(',').last;
      setState(() {
        _qrBytes = base64Decode(b64);
        _status  = 'INITIALIZING';
        _info    = 'Open WhatsApp → Linked Devices → Link a Device';
        _loading = false;
      });
    });

    _socket!.on('wa_authenticated_$id', (_) {
      if (!mounted) return;
      setState(() {
        _qrBytes = null;
        _info    = 'Authenticating…';
      });
    });

    _socket!.on('wa_ready_$id', (data) {
      if (!mounted) return;
      setState(() {
        _status  = 'READY';
        _qrBytes = null;
        _info    = 'Connected as ${data['name']} (+${data['number']})';
        _loading = false;
      });
      widget.onConnected();
    });

    _socket!.on('wa_disconnected_$id', (data) {
      if (!mounted) return;
      setState(() {
        _status  = 'DISCONNECTED';
        _qrBytes = null;
        _info    = 'Disconnected: ${data['reason']}';
      });
    });

    _socket!.on('wa_error_$id', (data) {
      if (!mounted) return;
      setState(() {
        _status  = 'DISCONNECTED';
        _loading = false;
        _info    = 'Error: ${data['message']}';
      });
    });

    _socket!.on('auth_error', (data) {
      if (!mounted) return;
      setState(() { _info = 'Auth error — invalid API key'; });
    });
  }

  Future<void> _connect() async {
    setState(() { _loading = true; _info = 'Starting WhatsApp…'; });
    try {
      await widget.service.initSlot(widget.slotId, widget.slotApiKey);
      // QR will arrive via socket event wa_qr_{slotId}
    } catch (e) {
      setState(() { _loading = false; _info = 'Failed: $e'; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Link WhatsApp')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _StatusChip(status: _status),
              const SizedBox(height: 24),

              // QR box
              Container(
                width: 240, height: 240,
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.grey.shade300, width: 2),
                  borderRadius: BorderRadius.circular(12),
                  color: Colors.grey.shade50,
                ),
                child: _qrBytes != null
                  ? ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: Image.memory(_qrBytes!, fit: BoxFit.contain),
                    )
                  : Center(
                      child: _loading
                        ? const CircularProgressIndicator()
                        : Icon(Icons.qr_code_2, size: 80, color: Colors.grey.shade400),
                    ),
              ),

              if (_info.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text(
                  _info,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 13, color: Colors.black54),
                ),
              ],

              const SizedBox(height: 24),

              if (_status == 'DISCONNECTED')
                FilledButton.icon(
                  onPressed: _loading ? null : _connect,
                  icon: const Icon(Icons.link),
                  label: const Text('Connect WhatsApp'),
                )
              else if (_status == 'READY')
                FilledButton.icon(
                  onPressed: null,
                  icon: const Icon(Icons.check_circle_outline),
                  label: const Text('Connected'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final String status;
  const _StatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (status) {
      'READY'        => ('Connected',    Colors.green),
      'INITIALIZING' => ('Connecting…',  Colors.orange),
      _              => ('Disconnected', Colors.grey),
    };
    return Chip(
      label: Text(label, style: TextStyle(color: color, fontWeight: FontWeight.bold)),
      backgroundColor: color.withOpacity(0.1),
      side: BorderSide(color: color.withOpacity(0.4)),
    );
  }
}
```

---

## 10. Error Handling

### HTTP status codes

| Code | Meaning | Flutter action |
|---|---|---|
| `200` | Success | — |
| `400` | Bad request (missing fields) | Show validation message |
| `401` | Expired/invalid token | Call `/api/auth/refresh`, retry; if fails → navigate to login |
| `403` | Forbidden | Show "insufficient permissions" |
| `404` | Slot/app not found | Re-create slot or show error |
| `503` | WhatsApp not ready | Show "Connect WhatsApp first" UI |

### Handling 401 in Flutter

```dart
try {
  final res = await authService.authedRequest('GET', '/api/me');
  // use res
} on UnauthorizedException {
  // Refresh already failed inside authedRequest — force re-login
  Navigator.of(context).pushReplacementNamed('/login');
}
```

### Slot is READY but send returns 503

This means the WhatsApp session dropped (phone disconnected, session expired). Re-init:

```dart
Future<void> reconnectIfNeeded(String slotId, String apiKey) async {
  final h = await service.checkHealth(slotId, apiKey);
  if (h['status'] != 'READY') {
    await service.initSlot(slotId, apiKey);
    // wait for wa_ready_{slotId} socket event before sending
  }
}
```

### Socket reconnects automatically

`socket_io_client` reconnects on its own. Re-subscribe after each reconnect:

```dart
socket.onReconnect((_) {
  socket.emit('subscribe_external', {'apiKey': slotApiKey, 'appId': slotId});
});
```

This is already handled in `WhatsAppService.connectSocket()` above.

---

## 11. pubspec.yaml Dependencies

```yaml
dependencies:
  flutter:
    sdk: flutter
  http:              ^1.2.1
  socket_io_client:  ^2.0.3+1
  shared_preferences: ^2.2.3
```

---

## Quick-Start Checklist

- [ ] Note your master app **App ID** and **API Key** from the platform dashboard
- [ ] From your backend (not the APK), call `POST /webhook/:masterAppId/slots` per admin user
- [ ] Store `{ slotId, apiKey }` per admin in your database
- [ ] On admin login: call `getOrCreateSlot(adminId)` → save `slotId` + `slotApiKey`
- [ ] Open "Link WhatsApp" screen: connect socket, call `initSlot()`, display QR
- [ ] Hide QR and show success on `wa_ready_{slotId}` socket event
- [ ] Before sending: call `checkHealth()` — if not `READY`, show reconnect UI
- [ ] All `/api/*` calls: pass `x-auth-token: <accessToken>` and auto-refresh on 401
- [ ] Set `JWT_SECRET` env variable on the server before going to production
