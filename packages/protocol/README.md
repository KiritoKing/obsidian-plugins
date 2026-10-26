# Browser title protocol

Version 1 uses UTF-8 JSON framed by a four-byte unsigned little-endian length on supported little-endian macOS/Linux hosts. A frame is capped at 1 MiB. The same codec is used for Native Messaging and local sockets.

The browser sends `hello` before the host creates a channel socket. A socket client reads the user-only runtime `connection.json`, sends `authenticate`, waits for `authenticated`, then sends a validated title request. Pairing material never belongs in plugin settings or Git.

`resolve-title`, `ping` and `cancel` are the initial operations. All replies are correlated by request ID. Adding methods or changing the public error contract requires coordinated changes to all packages.

`./paths` contains host-side path helpers and must not be imported into the browser bundle. `./identity` contains only a public extension key and its derived ID, never a private key.
