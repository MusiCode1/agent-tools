#!/usr/bin/env python3
"""Real browser callbacks, concurrent opens and manual-profile reuse on host net."""
import concurrent.futures
import http.server
import os
import queue
import socket
import subprocess
import threading
import time
import urllib.parse

container = os.environ.get('GUI_TEST_CONTAINER', 'linux-gui')
profile = f'smoke-url-{os.getpid()}'
runtime = f'/data/browser-projects/{profile}/runtime'
received = queue.Queue()


def dex(*args, check=True):
    return subprocess.run(['docker', 'exec', '--user', 'abc', container, *args],
                          check=check, capture_output=True, text=True, timeout=45)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        received.put(self.path)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<title>Local callback passed</title>callback passed')

    def log_message(self, *_):
        pass


class IPv6Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6


def open_url(url):
    dex('linux-gui-open-url', profile, url)


def wait_path(expected):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            value = received.get(timeout=1)
        except queue.Empty:
            continue
        if urllib.parse.unquote(value) == urllib.parse.unquote(expected):
            return
    raise AssertionError(f'Callback not received: {expected}')


def stop_profile():
    result = dex('cat', f'{runtime}/pid', check=False)
    if result.returncode == 0 and result.stdout.strip().isdigit():
        pid = result.stdout.strip()
        # Only the process started for this unique test profile is eligible.
        cmd = dex('cat', f'/proc/{pid}/cmdline', check=False).stdout.split('\0')
        if f'--user-data-dir=/data/browser-profiles/{profile}' in cmd:
            dex('kill', '-TERM', pid, check=False)
            for _ in range(40):
                if dex('kill', '-0', pid, check=False).returncode:
                    return
                time.sleep(.2)
            raise AssertionError('Test Chrome did not stop')


servers = []
occupied = socket.socket()
try:
    for candidate in range(9222, 9300):
        try:
            occupied.bind(('127.0.0.1', candidate))
            occupied.listen()
            break
        except OSError:
            continue
    else:
        raise AssertionError('No CDP port available for collision test')
    for server_class, address in [(http.server.ThreadingHTTPServer, '127.0.0.1'),
                                  (IPv6Server, '::1')]:
        server = server_class((address, 0), Handler)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{servers[0].server_port}'
    dex('mkdir', '-p', f'/data/browser-profiles/{profile}')
    paths = ['/cold-a', '/cold-b']
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        list(pool.map(open_url, [base + path for path in paths]))
    seen = set()
    deadline = time.monotonic() + 20
    while not set(paths) <= seen and time.monotonic() < deadline:
        try:
            seen.add(received.get(timeout=1))
        except queue.Empty:
            pass
    assert set(paths) <= seen, seen
    assert int(dex('cat', f'{runtime}/cdp-port').stdout) != candidate
    pid = dex('cat', f'{runtime}/pid').stdout
    special = '/warm?one=1&quote=\'&double="&dollar=$(true)&tick=`true`'
    open_url(base + special)
    wait_path(special)
    assert dex('cat', f'{runtime}/pid').stdout == pid
    open_url(f'http://[::1]:{servers[1].server_port}/ipv6')
    wait_path('/ipv6')
    for invalid in ['file:///etc/passwd', 'javascript:alert(1)', '--no-sandbox']:
        assert dex('linux-gui-open-url', profile, invalid, check=False).returncode != 0
    stop_profile()
    dex('linux-gui-browser-launch', profile, 'manual', base + '/manual-start')
    wait_path('/manual-start')
    pid = dex('cat', f'{runtime}/pid').stdout
    open_url(base + '/manual-reuse')
    wait_path('/manual-reuse')
    assert dex('cat', f'{runtime}/pid').stdout == pid
    assert dex('cat', f'{runtime}/mode').stdout.strip() == 'manual'
    print('PASS: concurrent cold opens; CDP port collision; warm reuse; literal URL; IPv4/IPv6 callbacks; scheme rejection; manual mode reuse')
finally:
    stop_profile()
    dex('rm', '-rf', f'/data/browser-profiles/{profile}', f'/data/browser-projects/{profile}', check=False)
    for server in servers:
        server.shutdown()
        server.server_close()
    occupied.close()
