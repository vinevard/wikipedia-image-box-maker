"""Local server for the comparison scripts.

Serves the repository root, plus:
  GET  /verify.html   index.html with hook.js injected, so the tool can be driven by query parameters
  GET  /sleep?s=N     an empty image after N seconds, to hold a page's load event
  POST /out/<name>    saves the request body to tools/verify/out/<name>
"""
import http.server
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "tools", "verify", "out")
PIXEL_GIF = bytes.fromhex("47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def handle(self):
        try:
            super().handle()
        except ConnectionResetError:
            pass  # capture.mjs closes Chrome as soon as it has what it needs

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/verify.html":
            with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
                page = f.read().replace("</body>", '<script src="tools/verify/hook.js"></script>\n</body>')
            self.reply(page.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/sleep":
            time.sleep(float(self.path.split("=")[-1]))
            self.reply(PIXEL_GIF, "image/gif")
        else:
            super().do_GET()

    def do_POST(self):
        name = os.path.basename(self.path.split("?")[0])
        body = self.rfile.read(int(self.headers["Content-Length"]))
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()

    def reply(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def serve(port):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8800)
