# C:\chroma_stack\ingest\ingest_offline.py
# Offline ingestion:
#  - loads TF-IDF→SVD embedder (pickle)
#  - walks configured roots
#  - parses .pdf/.docx/.txt/.md
#  - structure-aware chunking
#  - embeds -> Chroma (batched)
#  - builds Whoosh BM25 index per app
#
# Run:
#   C:\chroma_stack\venv\Scripts\Activate.ps1
#   python C:\chroma_stack\ingest\ingest_offline.py

from __future__ import annotations
import os
import sys
import uuid
import json
import math
import time
import pickle
import datetime as dt
from pathlib import Path
from typing import Dict, Any, List, Tuple, Iterable

# --- third-party ---
import yaml
import numpy as np
import chromadb
from chromadb.errors import InvalidDimensionError
from pypdf import PdfReader
from docx import Document

# local helpers
from hierarchy import derive_hierarchy
from chunking import chunk_structured
from whoosh_index import get_or_create, upsert

# ------------ config / paths ------------
BASE = Path(__file__).resolve().parents[1]
CFG_PATH = BASE / "ingest" / "config.yaml"
EMB_PATH = BASE / "models" / "tfidf_svd_384.pkl"
WHOOSH_DIR = BASE / "data" / "whoosh"

# ------------ settings ------------
BATCH_SIZE = 256            # safe for Chroma HTTP
PREVIEW_CHARS = 600         # store short doc preview in Chroma 'documents'
PDF_MAX_PAGES = 1500        # sanity guard
SLEEP_BETWEEN_BATCHES = 0.05  # small breather for Chroma

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
        # determine output dim by probing a tiny string
        probe = self._transform(["probe"])
        self.dim = int(probe.shape[1])

    def _transform(self, texts: List[str]):
        m = self.pipe.transform(texts)
        if hasattr(m, "toarray"):
            m = m.toarray()
        return m

    def embed_list(self, texts: List[str]) -> List[List[float]]:
        arr = self._transform(texts).astype(np.float32)
        # L2 normalize (keeps cosine sane)
        norms = np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9
        arr = arr / norms
        return [row.tolist() for row in arr]

# ------------ chroma batching ------------
def batched(seq: List[Any], n: int) -> Iterable[List[Any]]:
    for i in range(0, len(seq), n):
        yield seq[i : i + n]

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

    # 2) Chroma client
    client = chromadb.HttpClient(
        host=cfg["chroma"]["host"],
        port=int(cfg["chroma"]["port"]),
        ssl=bool(cfg["chroma"].get("ssl", False)),
        headers=cfg["chroma"].get("headers") or {},
    )

    include_exts = set(e.lower() for e in cfg["include_extensions"])
    max_bytes = int(cfg.get("max_mb", 25)) * 1024 * 1024

    WHOOSH_DIR.mkdir(parents=True, exist_ok=True)
    whoosh_ix_by_app = {}

    def get_ix(app: str):
        if app not in whoosh_ix_by_app:
            whoosh_ix_by_app[app] = get_or_create(WHOOSH_DIR / app)
        return whoosh_ix_by_app[app]

    # 3) For each collection/app
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
            # If a prior collection has a different dim, tell the user clearly.
            raise SystemExit(
                f"Chroma collection '{coll_name}' has incompatible dimension. "
                f"Delete it or recreate the DB. Details: {e}"
            )

        ix = get_ix(app)
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

                    # build per-file buffers
                    ids: List[str] = []
                    docs: List[str] = []
                    metas: List[Dict[str, Any]] = []
                    payload_texts: List[str] = []

                    base_meta = derive_hierarchy(root, full)
                    for ch in chs:
                        piece = (ch["body"] or "").strip()
                        if not piece:
                            continue
                        ids.append(uuid.uuid4().hex)
                        docs.append(piece[:PREVIEW_CHARS])
                        m = {
                            **base_meta,
                            "kind": "doc",
                            "app": app,
                            "source_path": full,
                            "section_title": ch.get("title") or "",
                            "seq_idx": int(ch.get("seq_idx", 0)),
                            "ingested_at": utc_now(),
                        }
                        metas.append(m)
                        payload_texts.append(piece)

                    if not ids:
                        continue

                    # embed + upload in batches (to avoid HTTP body too large)
                    for b_ids, b_docs, b_metas, b_texts in zip(
                        batched(ids, BATCH_SIZE),
                        batched(docs, BATCH_SIZE),
                        batched(metas, BATCH_SIZE),
                        batched(payload_texts, BATCH_SIZE),
                    ):
                        vecs = emb.embed_list(b_texts)
                        # Sanity check: consistent dims
                        if any(len(v) != emb.dim for v in vecs):
                            raise RuntimeError("Embedding dimension mismatch within batch.")
                        coll.add(
                            ids=list(b_ids),
                            documents=list(b_docs),
                            metadatas=list(b_metas),
                            embeddings=vecs,
                        )
                        time.sleep(SLEEP_BETWEEN_BATCHES)

                    # stage BM25 upserts (raw text, not preview)
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

                    # periodic whoosh commits to keep memory bounded
                    if len(to_upsert_for_bm25) >= 5000:
                        upsert(ix, to_upsert_for_bm25)
                        log(f"  [BM25] committed {len(to_upsert_for_bm25)} docs")
                        to_upsert_for_bm25.clear()

        # final whoosh commit for this collection
        if to_upsert_for_bm25:
            upsert(ix, to_upsert_for_bm25)
            log(f"  [BM25] committed {len(to_upsert_for_bm25)} docs")

        log(f"=== done: files={file_count}, chunks={chunk_count} ===")

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
