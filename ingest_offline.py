# C:\chroma_stack\ingest\ingest_offline.py
# Offline ingestion:
#  - loads TF-IDF→SVD embedder (pickle)
#  - walks configured roots
#  - parses .pdf/.docx/.txt/.md
#  - structure-aware chunking
#  - dedupes (exact + near-dup) with deterministic IDs h:<sha256>
#  - embeds -> Chroma (batched)
#  - emits JSONL per app for Pyserini indexing
#  - optional Whoosh BM25 index (toggle in config.yaml)

from __future__ import annotations
import os
import sys
import re
import json
import time
import math
import uuid
import pickle
import hashlib
import datetime as dt
from pathlib import Path
from typing import Dict, Any, List, Iterable

import yaml
import numpy as np
import chromadb
from chromadb.errors import InvalidDimensionError
from pypdf import PdfReader
from docx import Document

# local helpers
from hierarchy import derive_hierarchy
from chunking import chunk_structured

# Optional Whoosh (can be disabled via config)
try:
    from whoosh_index import get_or_create, upsert  # our thin wrapper
    WHOOSH_AVAILABLE = True
except Exception:
    WHOOSH_AVAILABLE = False

# ------------ config / paths ------------
BASE = Path(__file__).resolve().parents[1]
CFG_PATH = BASE / "ingest" / "config.yaml"
EMB_PATH = BASE / "models" / "tfidf_svd_384.pkl"
WHOOSH_DIR = BASE / "data" / "whoosh"
CORPUS_DIR = BASE / "pyserini_corpus"  # JSONL output for Pyserini

# ------------ settings ------------
BATCH_SIZE = 256              # Chroma HTTP-safe batch size
PREVIEW_CHARS = 600           # preview stored in Chroma 'documents'
PDF_MAX_PAGES = 1500
SLEEP_BETWEEN_BATCHES = 0.05  # small pause between Chroma batches

# ------------ dedupe helpers ------------
_ws = re.compile(r"\s+")
_boiler = re.compile(r"(^\s*page\s+\d+\s*$)|(^\s*confidential\s*$)", re.I | re.M)

def normalize_for_hash(text: str) -> str:
    t = _boiler.sub(" ", text)
    t = t.lower()
    t = _ws.sub(" ", t).strip()
    return t

def chunk_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def simhash(text: str, n=64) -> int:
    tokens = [w for w in re.findall(r"\b[\w\-]+\b", text.lower()) if w]
    if not tokens: return 0
    v = [0]*n
    for w in tokens:
        h = int(hashlib.md5(w.encode("utf-8")).hexdigest(), 16)
        for i in range(n):
            v[i] += 1 if ((h >> i) & 1) else -1
    out = 0
    for i in range(n):
        if v[i] >= 0:
            out |= (1 << i)
    return out

def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()

# ------------ utils ------------
def utc_now() -> str:
    return dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"

def log(msg: str):
    print(msg, flush=True)

def load_yaml(path: Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

def safe_file_size(p: str) -> int | None:
    try:
        return os.path.getsize(p)
    except FileNotFoundError:
        return None

# ------------ text loaders ------------
def load_text(path: str) -> str:
    p = path.lower()
    try:
        if p.endswith(".pdf"):
            return load_pdf_text(path)
        elif p.endswith(".docx"):
            return load_docx_text(path)
        elif p.endswith((".txt", ".md")):
            return open(path, "r", encoding="utf-8", errors="ignore").read()
        else:
            return ""
    except Exception as e:
        log(f"  ! error reading {path}: {e}")
        return ""

def load_pdf_text(path: str) -> str:
    out: List[str] = []
    with open(path, "rb") as f:
        reader = PdfReader(f)
        n = min(len(reader.pages), PDF_MAX_PAGES)
        for i in range(n):
            try:
                txt = reader.pages[i].extract_text() or ""
            except Exception:
                txt = ""
            if txt.strip():
                out.append(txt)
    return "\n".join(out)

def load_docx_text(path: str) -> str:
    with open(path, "rb") as f:
        doc = Document(f)
        return "\n".join([p.text for p in doc.paragraphs])

# ------------ embedder wrapper ------------
class Embedder:
    def __init__(self, pipe):
        self.pipe = pipe
        probe = self._transform(["probe"])
        self.dim = int(probe.shape[1])

    def _transform(self, texts: List[str]):
        m = self.pipe.transform(texts)
        if hasattr(m, "toarray"):
            m = m.toarray()
        return m

    def embed_list(self, texts: List[str]) -> List[List[float]]:
        arr = self._transform(texts).astype(np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9
        arr = arr / norms
        return [row.tolist() for row in arr]

# ------------ chroma batching ------------
def batched(seq: List[Any], n: int) -> Iterable[List[Any]]:
    for i in range(0, len(seq), n):
        yield seq[i : i + n]

# ------------ JSONL writers (Pyserini) ------------
_jsonl_writers: Dict[str, Any] = {}

def get_jsonl_writer(app: str):
    if app not in _jsonl_writers:
        pdir = CORPUS_DIR / f"{app}_jsonl"
        pdir.mkdir(parents=True, exist_ok=True)
        p = pdir / f"{app}.jsonl"
        _jsonl_writers[app] = open(p, "a", encoding="utf-8")
    return _jsonl_writers[app]

# ------------ main ingest ------------
def main():
    # 1) Load config + embedder
    if not CFG_PATH.exists():
        raise SystemExit(f"Missing config: {CFG_PATH}")
    cfg = load_yaml(CFG_PATH)

    if not EMB_PATH.exists():
        raise SystemExit(f"Missing embedder pickle: {EMB_PATH}")

    with open(EMB_PATH, "rb") as f:
        pipe = pickle.load(f)
    emb = Embedder(pipe)
    log(f"Embedder loaded. Output dim = {emb.dim}")

    # 2) Toggle Whoosh
    USE_WHOOSH = bool((cfg.get("whoosh") or {}).get("enabled", True) and WHOOSH_AVAILABLE)
    if USE_WHOOSH:
        WHOOSH_DIR.mkdir(parents=True, exist_ok=True)
    else:
        log("Whoosh indexing disabled (config or module unavailable).")

    # 3) Chroma client
    client = chromadb.HttpClient(
        host=cfg["chroma"]["host"],
        port=int(cfg["chroma"]["port"]),
        ssl=bool(cfg["chroma"].get("ssl", False)),
        headers=cfg["chroma"].get("headers") or {},
    )

    include_exts = set(e.lower() for e in cfg["include_extensions"])
    max_bytes = int(cfg.get("max_mb", 25)) * 1024 * 1024

    # Dedupe caches & counters (per run)
    seen_hashes: set[str] = set()
    seen_simhashes: List[int] = []
    exact_dups_skipped = 0
    near_dups_skipped = 0

    whoosh_ix_by_app = {}

    def ix_for(app: str):
        if not USE_WHOOSH:
            return None
        if app not in whoosh_ix_by_app:
            whoosh_ix_by_app[app] = get_or_create(WHOOSH_DIR / app)
        return whoosh_ix_by_app[app]

    # 4) For each collection/app
    for coll_cfg in cfg["collections"]:
        coll_name = coll_cfg["name"]
        app = coll_cfg["app"]

        log(f"\n=== [{coll_name}] (app={app}) ===")
        try:
            coll = client.get_or_create_collection(
                name=coll_name,
                metadata={"embedder": "tfidf_svd_384", "hnsw:space": "cosine"},
            )
        except InvalidDimensionError as e:
            raise SystemExit(
                f"Chroma collection '{coll_name}' has incompatible dimension. "
                f"Delete it or recreate the DB. Details: {e}"
            )

        ix = ix_for(app)
        to_upsert_for_bm25: List[Dict[str, Any]] = []

        roots = [r for r in cfg["roots"] if r.get("app") == app]
        if not roots:
            log(f"  ! No roots configured for app '{app}', skipping.")
            continue

        file_count = 0
        chunk_count = 0

        for root in roots:
            root_path = root["path"]
            log(f"  Walking: {root_path}")
            for dirpath, _, files in os.walk(root_path):
                for fn in files:
                    full = os.path.join(dirpath, fn)
                    ext = os.path.splitext(full)[1].lower()
                    if ext not in include_exts:
                        continue
                    size = safe_file_size(full)
                    if size is None:
                        continue
                    if size > max_bytes:
                        log(f"  - skip (size>{cfg.get('max_mb',25)}MB): {full}")
                        continue

                    text = load_text(full)
                    if not text or not text.strip():
                        continue

                    # chunk
                    chs = chunk_structured(text, cfg["chunk"]["tokens"], cfg["chunk"]["overlap"])
                    if not chs:
                        continue

                    # per-file buffers
                    ids: List[str] = []
                    docs: List[str] = []
                    metas: List[Dict[str, Any]] = []
                    payload_texts: List[str] = []

                    base_meta = derive_hierarchy(root, full)
                    w_jsonl = get_jsonl_writer(app)

                    for ch in chs:
                        piece = (ch["body"] or "").strip()
                        if not piece:
                            continue

                        # dedupe
                        norm = normalize_for_hash(piece)
                        hid = chunk_sha256(norm)
                        if hid in seen_hashes:
                            exact_dups_skipped += 1
                            continue

                        sh = simhash(norm)
                        if any(hamming(sh, prev) <= 3 for prev in seen_simhashes):
                            near_dups_skipped += 1
                            continue

                        # mark seen
                        seen_hashes.add(hid)
                        seen_simhashes.append(sh)

                        # deterministic ID
                        cid = f"h:{hid}"

                        ids.append(cid)
                        docs.append(piece[:PREVIEW_CHARS])
                        meta = {
                            **base_meta,
                            "kind": "doc",
                            "app": app,
                            "source_path": full,
                            "section_title": ch.get("title") or "",
                            "seq_idx": int(ch.get("seq_idx", 0)),
                            "ingested_at": utc_now(),
                            "hash": hid,
                            "simhash": sh
                        }
                        metas.append(meta)
                        payload_texts.append(piece)

                        # JSONL for Pyserini
                        rec = {"id": cid, "contents": piece, "raw": json.dumps(meta, ensure_ascii=False)}
                        w_jsonl.write(json.dumps(rec, ensure_ascii=False) + "\n")

                    if not ids:
                        continue

                    # embed + upload to Chroma in batches
                    for b_ids, b_docs, b_metas, b_texts in zip(
                        batched(ids, BATCH_SIZE),
                        batched(docs, BATCH_SIZE),
                        batched(metas, BATCH_SIZE),
                        batched(payload_texts, BATCH_SIZE),
                    ):
                        vecs = emb.embed_list(b_texts)
                        coll.add(
                            ids=list(b_ids),
                            documents=list(b_docs),
                            metadatas=list(b_metas),
                            embeddings=vecs,
                        )
                        time.sleep(SLEEP_BETWEEN_BATCHES)

                    # stage Whoosh upserts (raw text, not preview)
                    if USE_WHOOSH:
                        for i, piece in enumerate(payload_texts):
                            to_upsert_for_bm25.append(
                                {
                                    "doc_id": ids[i],
                                    "app": app,
                                    "title": metas[i]["section_title"] or "",
                                    "text": piece,
                                    "source": full,
                                }
                            )

                    file_count += 1
                    chunk_count += len(ids)
                    log(f"    + {len(ids):4d} chunks   {full}")

                    # periodic Whoosh commits
                    if USE_WHOOSH and len(to_upsert_for_bm25) >= 5000:
                        upsert(ix, to_upsert_for_bm25)
                        log(f"  [BM25/Whoosh] committed {len(to_upsert_for_bm25)} docs")
                        to_upsert_for_bm25.clear()

        # final Whoosh commit for this collection
        if USE_WHOOSH and to_upsert_for_bm25:
            upsert(ix, to_upsert_for_bm25)
            log(f"  [BM25/Whoosh] committed {len(to_upsert_for_bm25)} docs")

        log(f"=== done: files={file_count}, chunks={chunk_count} ===")

    # dedupe summary
    log(f"  [dedupe] exact_skipped={exact_dups_skipped} near_skipped={near_dups_skipped}")

    # close JSONL writers
    for fh in _jsonl_writers.values():
        try: fh.close()
        except: pass

    log("\nAll collections ingested successfully.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("\nInterrupted by user.")
        sys.exit(1)
    except Exception as e:
        log(f"\nFATAL: {e}")
        sys.exit(2)
