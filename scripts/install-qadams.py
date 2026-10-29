#!/usr/bin/env python3
"""Fetch compiled @aiqadam/qadam-* tarballs from npm and place their dist/ into the repo layout the API scans.

Why: in a source-based install the API loads qadams from packages/qadams/**/dist at startup.
Building all 238 takes 30-60 minutes; the npm packages carry the same versions already compiled,
so this script installs the whole catalog in minutes.

Expected target layout (per packages/server/api/src/app/qadams/metadata/utils/file-qadams-utils.ts):
  packages/qadams/<scope>/<qadam-name>/dist/package.json
  packages/qadams/<scope>/<qadam-name>/dist/src/index.js
  packages/qadams/<scope>/<qadam-name>/dist/src/i18n/ (optional)

npm tarball layout: package/package.json + package/src/... (the tarball's package/ IS the dist content).
Mapping: copy the whole package/ into <qadam>/dist/.

After running: restart the stack so the API rescans the dists.
If the catalog comes up empty after a fresh `bun install`, the runtime needs the workspace
symlinks the isolated linker does not create at the repo root:

    mkdir -p node_modules/@aiqadam
    ln -sfn ../../packages/shared node_modules/@aiqadam/shared
    ln -sfn ../../packages/qadams/framework node_modules/@aiqadam/qadams-framework
    ln -sfn ../../packages/qadams/common node_modules/@aiqadam/qadams-common
"""
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

REGISTRY = "https://registry.npmjs.org"
# Repo kökü: bu script scripts/ altında yaşar, kök onun bir üstü.
REPO = Path(__file__).resolve().parents[1]
# Tarball önbelleği: aynı sürümü tekrar indirmemek için kalıcı dizin.
WORK = Path(os.environ.get("QF_QADAM_TARBALL_CACHE", "/tmp/opencode/qadam-tarballs"))
WORK.mkdir(parents=True, exist_ok=True)

def http_json(url: str, timeout=15):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def download(url: str, dest: Path, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)

def main():
    scopes = ["core", "community"]
    packages = []
    for scope in scopes:
        root = REPO / "packages" / "qadams" / scope
        for d in sorted(root.iterdir()):
            pj = d / "package.json"
            if not pj.exists():
                continue
            meta = json.loads(pj.read_text())
            packages.append({
                "name": meta["name"],
                "version": meta["version"],
                "dir": d,
                "scope": scope,
            })
    print(f"Repo qadam paketleri: {len(packages)}")

    ok, mismatch, failed = [], [], []
    for i, p in enumerate(packages, 1):
        enc = urllib.parse.quote(p["name"], safe="")
        try:
            # try exact version first
            ver_meta = http_json(f"{REGISTRY}/{enc}/{p['version']}")
            tarball, chosen = ver_meta["dist"]["tarball"], p["version"]
        except (urllib.error.HTTPError, KeyError):
            try:
                pkg_meta = http_json(f"{REGISTRY}/{enc}")
                latest = pkg_meta["dist-tags"]["latest"]
                ver_meta = http_json(f"{REGISTRY}/{enc}/{latest}")
                tarball, chosen = ver_meta["dist"]["tarball"], latest
            except Exception as e:
                failed.append((p["name"], str(e)))
                continue

        try:
            tgz = WORK / (p["name"].replace("@", "").replace("/", "_") + ".tgz")
            if not tgz.exists():
                download(tarball, tgz)
            with tempfile.TemporaryDirectory(dir=WORK) as td:
                with tarfile.open(tgz) as t:
                    t.extractall(td, filter="tar")
                src_pkg = Path(td) / "package"
                # tarball package/ IS the dist content: package.json + src/index.js + src/i18n
                dist_dir = p["dir"] / "dist"
                if dist_dir.exists():
                    shutil.rmtree(dist_dir)
                shutil.copytree(src_pkg, dist_dir)
            chosen_ver = ver_meta.get("version", chosen)
            if chosen_ver != p["version"]:
                mismatch.append((p["name"], p["version"], chosen_ver))
                print(f"[{i}/{len(packages)}] ~ {p['name']} repo={p['version']} npm={chosen_ver}")
            else:
                ok.append(p["name"])
                print(f"[{i}/{len(packages)}] + {p['name']}@{chosen_ver}")
        except Exception as e:
            failed.append((p["name"], str(e)))
            print(f"[{i}/{len(packages)}] ! {p['name']}: {e}")

    print("\n=== ÖZET ===")
    print(f"Tam eşleşme: {len(ok)}")
    print(f"Sürüm farkıyla alındı: {len(mismatch)}")
    for n, rv, nv in mismatch:
        print(f"  ~ {n}: repo {rv} -> npm {nv}")
    print(f"Başarısız (local build gerekir): {len(failed)}")
    for n, e in failed:
        print(f"  ! {n}: {e}")
    (WORK / "build-needed.json").write_text(json.dumps([f[0] for f in failed], indent=2))

if __name__ == "__main__":
    sys.exit(main())
