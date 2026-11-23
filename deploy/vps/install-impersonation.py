"""Install the pinned Linux x86_64 network library used by the DMIT fallback."""
import hashlib
import io
import pathlib
import tarfile
import urllib.request

URL = "https://github.com/lexiforest/curl-impersonate/releases/download/v2.3.2/libcurl-impersonate-v2.3.2.x86_64-linux-gnu.tar.gz"
SHA256 = "7716be1ec87f13ecc776c211003bd1122c345287829b1f18a494a5467c90ab1e"

def main():
    data = urllib.request.urlopen(URL, timeout=60).read(32 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError("curl-impersonate archive checksum mismatch")
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        members = [m for m in archive.getmembers() if m.isfile() and pathlib.PurePosixPath(m.name).name.startswith("libcurl-impersonate.so")]
        if len(members) != 1:
            raise RuntimeError("Unexpected curl-impersonate archive layout")
        library = archive.extractfile(members[0]).read()
    destination = pathlib.Path("/opt/resnode-radar-egress/libcurl-impersonate.so")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".so.tmp")
    temporary.write_bytes(library)
    temporary.chmod(0o644)
    temporary.replace(destination)
    print("Installed verified curl-impersonate v2.3.2:", hashlib.sha256(library).hexdigest())

if __name__ == "__main__":
    main()
