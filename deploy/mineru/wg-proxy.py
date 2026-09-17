#!/usr/bin/env python3
import asyncio
import ipaddress
import logging
import os
import sys
import urllib.request

LISTEN_HOST = os.environ.get("MINERU_WG_LISTEN_HOST", "10.77.0.2")
LISTEN_PORT = int(os.environ.get("MINERU_WG_LISTEN_PORT", "8000"))
UPSTREAM_HOST = os.environ.get("MINERU_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("MINERU_UPSTREAM_PORT", "8000"))

listen_address = ipaddress.ip_address(LISTEN_HOST)
if listen_address.is_unspecified or not (
    listen_address.is_private or listen_address.is_loopback
):
    raise ValueError("MINERU_WG_LISTEN_HOST must be a private or loopback IP address")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mineru-wg-proxy")


async def relay(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.write_eof()
        except (AttributeError, OSError):
            pass


async def handle(client_reader, client_writer):
    peer = client_writer.get_extra_info("peername")
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(
            UPSTREAM_HOST,
            UPSTREAM_PORT,
        )
    except OSError as error:
        log.warning("upstream unavailable for %s: %s", peer, error)
        client_writer.close()
        await client_writer.wait_closed()
        return

    try:
        await asyncio.gather(
            relay(client_reader, upstream_writer),
            relay(upstream_reader, client_writer),
        )
    finally:
        upstream_writer.close()
        client_writer.close()
        await asyncio.gather(
            upstream_writer.wait_closed(),
            client_writer.wait_closed(),
            return_exceptions=True,
        )


async def main():
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
    sockets = ", ".join(str(sock.getsockname()) for sock in server.sockets or ())
    log.info("listening on %s -> %s:%s", sockets, UPSTREAM_HOST, UPSTREAM_PORT)
    async with server:
        await server.serve_forever()


def healthcheck():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(
        f"http://{LISTEN_HOST}:{LISTEN_PORT}/health",
        timeout=5,
    ) as response:
        if response.status != 200:
            raise SystemExit(1)


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        healthcheck()
    else:
        asyncio.run(main())
