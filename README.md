# Iris HTTP Server

An Iris v1 HTTP/1.1 loopback demo. `src/main.ir` owns the socket loop and calls
the native `Network` TCP primitives; `src/http.ir` parses headers and constructs
responses. There is no Rust HTTP server loop, source interpolation, request-body
parser, keepalive, TLS, concurrency, or production server claim.

The root manifest lists both sources in execution order and directly depends on
[iris-network](https://github.com/yuwenhuisama/iris-network) at a full Git revision.
The checked-in `iris.lock` records exact source and metadata digests. Installation
fetches the locked sources; the separate authorized build produces a local native
artifact. Neither source evaluation nor VM execution downloads or builds code.

## API

`src/http.ir` defines one public method:

```iris
Http.response(rawHeaders: String) -> String
```

Pass exactly one complete header section, including its final `\r\n\r\n`,
as data. The returned String is the complete HTTP response. Use its actual
`to_bytes()` method to encode it as UTF-8 for the socket writer.
Do not concatenate, interpolate, or evaluate received data as Iris source.

| Request | Response |
| --- | --- |
| `GET /` | `200 OK`, `text/plain; charset=utf-8`, `Hello, Iris!\n` |
| `GET /health` | `200 OK`, `application/json`, `{"status":"ok"}\n` |
| Other GET path | `404 Not Found`, `Not Found\n` |
| Other valid method | `405 Method Not Allowed`, `Allow: GET` |
| `HEAD` | `405`, `Allow: GET`, zero Content-Length and no body |
| Malformed or unsupported header input | `400 Bad Request` |

Routes are case-sensitive; query strings are ignored. No percent-decoding or
path normalization is performed. Only GET is implemented, not HEAD semantics.
Every response uses CRLF lines, a CRLFCRLF terminator, `Connection: close`,
and Content-Length derived from **UTF-8 bytes**, not character count. Current
fixed response bodies are ASCII, so their byte counts are 13, 16, 10, 19 and
12 respectively; HEAD's rejection body is empty.

## Deliberately Bounded Input Profile

- Maximum 8192 UTF-8 bytes, including the terminator; maximum 64 header fields.
  The byte bound is checked before splitting or allocating parser collections.
- Exactly `METHOD SP origin-target SP HTTP/1.1`; no HTTP/1.0, absolute URI,
  fragments, empty targets, or whitespace-normalized request lines.
- ASCII headers only. Visible ASCII plus horizontal tab in field values is
  accepted. Bare CR/LF, other controls, DEL, obsolete folding, and invalid field
  name tokens are rejected. This deliberately excludes HTTP obs-text.
- Exactly one nonempty case-insensitive Host field is required. Obvious
  whitespace/list/userinfo/path delimiters are rejected. Host is not used for
  routing or authorization; this demo does not implement full URI authority,
  IPv6 literal, port, or percent-escape validation.
- Transfer-Encoding is rejected. Content-Length must be a single nonempty
  decimal value. GET accepts only a zero value; another method is rejected
  with 405 without waiting for its declared body. No body is read or parsed.
- Input after the first terminator, including a body or pipelined request,
  is rejected by `Http.response`. The socket adapter passes only the first
  header section, discards already-read trailing bytes, writes once per
  connection (with partial-write accounting), then closes.

## Run And Verify Locally

Requires an Iris CLI with package support, Git, and Rust 1.93 or newer for the
native dependency build. Build the CLI from Iris-Language `new-iris-dev` at
`b8e126ee9c97ae1c77bec0a787485f9d56183c26` or a compatible later revision with
`cargo build -p iris-cli --locked`. Run the following from this repository.
Native builds execute trusted code; review the pinned dependency before
authorizing its build and runtime permissions.

On Windows, this repository's `.gitattributes` keeps locked files LF even with
`core.autocrlf=true` (parent-repository attributes do not govern a submodule).
For an older CRLF checkout reporting `Integrity` / `package integrity mismatch`,
inspect `git diff` and `git diff --cached` first. From this demo directory, this
PowerShell snippet converts only CRLF to LF in the three locked root files,
preserving all other bytes and edits:

```powershell
$bytesEncoding = [System.Text.Encoding]::GetEncoding(28591)
foreach ($file in @('iris.toml', 'src/http.ir', 'src/main.ir')) {
    $path = (Resolve-Path $file).Path
    $text = $bytesEncoding.GetString([System.IO.File]::ReadAllBytes($path))
    [System.IO.File]::WriteAllBytes($path, $bytesEncoding.GetBytes($text.Replace("`r`n", "`n")))
}
git diff
```

Retry installation; other source edits still fail the exact-byte lock check.
Do not delete/regenerate `iris.lock` or force a checkout over your edits to bypass
integrity. A displayed `\\?\` prefix is Windows canonical path notation, not
evidence of the cause. Offline checkout regression: `node tests/checkout.mjs`;
append an absolute Iris CLI path to also test install and tamper rejection
(downloads the pinned dependency).

```bash
IRIS=/absolute/path/to/iris
"$IRIS" package install .
"$IRIS" package build . --allow-native-build
"$IRIS" package run . --allow native.load,native.blocking,network.tcp
# Or select the VM:
"$IRIS" package run . --allow native.load,native.blocking,network.tcp --vm
```

In another terminal, before the 30-second idle accept timeout:

```sh
curl -i http://127.0.0.1:8080/
curl -i http://127.0.0.1:8080/health
curl -i http://127.0.0.1:8080/missing
```

The server prints its bound loopback address. Run the automatic suites with no
other process listening on port 8080; do not run two demo suites concurrently:

```sh
IRIS=/absolute/path/to/iris
# Pure tests combine only trusted repository source, excluding main.ir startup:
"$IRIS" -e "$(cat src/http.ir tests/test_http.ir)"
"$IRIS" --vm -e "$(cat src/http.ir tests/test_http.ir)"
# Live suites require package install/build above:
node tests/live.mjs "$IRIS"
node tests/curl.mjs "$IRIS"
```

Each live suite invokes `iris package run` for both reference and VM execution,
with only `native.load,native.blocking,network.tcp` granted. Readiness defaults
to 60 seconds; set `IRIS_STARTUP_TIMEOUT_MS` to a positive integer in milliseconds
to override it (for example, `IRIS_STARTUP_TIMEOUT_MS=120000 node tests/live.mjs "$IRIS"`).
Startup, protocol, and shutdown failures produce a nonzero test exit status.

Tests construct request data at runtime; no request is executable source.
The pure tests raise `HttpTestFailure` on response mismatch, producing a nonzero
exit status. Each named fixture is Given, the handler invocation is When, and
exact wire-response comparison is Then. The live suite starts each engine,
awaits its readiness output, drives real TCP connections, checks complete wire
responses, and verifies normal process exit after the 64th client. Its cleanup
terminates only the process it started if a test fails.

Both pure-test modes produce 47 `PASS` lines followed by:

```text
HTTP tests passed: 47
```

Coverage includes routes, method rejection (including `1GET`, numeric and keyword
tokens), source-like method data, a subsequent successful GET, malformed framing, Host handling,
controls, body policy, duplicate lengths, source-like data, 8192/8193-byte
boundaries, UTF-8 byte-limit overflow, and 64/65-field boundaries. There is no
`.ir` LSP configured; actual reference execution and VM compilation/execution
are the validation gates. The live suite covers routes, malformed/invalid UTF-8
input, writes split across client calls, pipelined trailing bytes, 8192/8193-byte
boundaries, incomplete EOF, idle read timeout, and clean 64-client shutdown on
both engines. Client write splitting does not guarantee separate TCP packets;
small loopback responses also do not force a partial native write.
The live suite rejects digit-prefixed and numeric methods with 405 and source-like
invalid method data with 400, then verifies subsequent GET requests still work.
The curl suite checks `1GET /` returns 405 before a successful `GET /`, then
`/health` and `/missing`, using the real curl binary,
then observes normal idle-accept shutdown after 30 seconds on each engine.

## Socket Bounds And Cleanup

`Main.run()` starts from the Main Module body, binds `127.0.0.1:8080`, accepts at most
64 clients sequentially, and exits normally after a 30-second idle accept.
The listener is always closed by `finally`; each accepted client also has a
`finally` close on success or failure. Unexpected native errors propagate.

Headers are capped at 8192 bytes and 64 reads, each with a 100 ms timeout.
Scanning retains possible CRLFCRLF prefixes between chunks and decodes only
the complete first header slice with `Encoding::UTF_8.decode`. EOF, timeout,
invalid encoding, and incomplete or oversized headers produce 400 when the
peer can still receive. No body is awaited. A peer reset may prevent delivery.

Responses use at most 64 writes with a 100 ms timeout each, advancing by the
actual byte count. Zero progress ends the client. These operation budgets bound
socket waiting to about 6.4 seconds per phase, rather than providing a strict
wall-clock deadline: interpreter work, OS timeout granularity, and scheduling
add overhead. Inclusive Bytes slices are used because the current VM mishandles
an exclusive slice whose endpoint equals the byte-buffer length.

Native code is trusted process code, not a sandbox. Grants authorize loading
and TCP operations, not OS isolation. Keep this demo on loopback.
