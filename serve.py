import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, format, *args):
        pass


class FastThreadingHTTPServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    with FastThreadingHTTPServer(('0.0.0.0', PORT), Handler) as httpd:
        print(f"CAD-Map Overlay App running at http://127.0.0.1:{PORT} (and http://localhost:{PORT})")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
