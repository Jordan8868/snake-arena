# Third-party notices

This project uses or bundles the following third-party components:

## Microsoft WebView2 SDK

`desktop/webview2/` contains redistributable DLLs from the Microsoft WebView2 SDK:

- `Microsoft.Web.WebView2.Core.dll`
- `Microsoft.Web.WebView2.WinForms.dll`
- `WebView2Loader.dll`

Copyright (c) Microsoft Corporation. Distributed under the Microsoft WebView2 SDK
license. See <https://learn.microsoft.com/microsoft-edge/webview2/>.

## localhost.run

The optional public-tunnel feature starts the system SSH client and connects to
[localhost.run](https://localhost.run/). localhost.run is a third-party service and
is not affiliated with this project; its availability and terms are outside this
repository's control.

## Node.js

Node.js is required to run the server, but is not included in this source
repository. The Windows build script copies the locally installed `node` executable
into the generated portable package.
