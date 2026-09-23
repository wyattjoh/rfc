# q6 — WebSocket handshake (RFC 6455, no number given)

1. GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` — **RFC 6455 §1.3** (L383) or
   **§4.2.2** (L1313), or §4.1 client check (L1050).
2. Hash: **SHA-1** of key + GUID, then base64-encoded — same sections
   (§1.3 / §4.2.2 / §4.1 L1047–1049).
3. `Sec-WebSocket-Version` **MUST be 13** — **RFC 6455 §4.1** item 9 (L987–989);
   §4.2.1 item 6 (L1160) also accepted.
