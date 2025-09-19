# C:\chroma_stack\mcp\rag_mcp.py
# pip install fastmcp requests
import os, json, requests
from typing import List, Optional
from fastmcp import FastMCP, tool

RAG_BASE  = os.environ.get("RAG_BASE", "http://127.0.0.1:8091")
MEM_URL   = os.environ.get("MEM_URL",  "http://127.0.0.1:8080/memory/append")
MEM_TOKEN = os.environ.get("MEM_TOKEN", "super-secret-token")
TIMEOUT_S = float(os.environ.get("MCP_HTTP_TIMEOUT", "60"))

mcp = FastMCP("rag-tools")

@tool(description="Hybrid retrieve (FAISS vectors + Whoosh BM25) with keyword/phrase controls. Returns JSON string.")
def retrieve_hybrid(
    q: str,
    app_name: str = "claims",
    top_k: int = 8,
    pool: int = 80,
    signal: str = "hybrid",            # "hybrid" | "faiss" | "bm25" | "chroma"
    reembed_previews: bool = True,

    must: str = "",                    # space/comma separated required tokens
    must_phrases: str = "",            # semicolon-separated phrases
    min_hits: int = 0,                 # 0 => require all 'must' terms; else minimum
    proximity: int = 0                 # phrase slop (0 = exact)
) -> str:
    params = {
        "q": q, "app_name": app_name, "top_k": top_k, "pool": pool,
        "signal": signal, "reembed_previews": json.dumps(reembed_previews),
        "must": must, "must_phrases": must_phrases,
        "min_hits": min_hits, "proximity": proximity
    }
    r = requests.get(f"{RAG_BASE}/retrieve", params=params, timeout=TIMEOUT_S)
    r.raise_for_status()
    return json.dumps(r.json(), ensure_ascii=False)

@tool(description="Fetch ±radius neighbor chunks from the same file. Returns JSON string.")
def get_neighbors(
    source_path: str,
    seq_idx: int,
    app_name: str = "claims",
    radius: int = 1,
    limit: int = 10
) -> str:
    params = {"app_name": app_name, "source_path": source_path, "seq_idx": seq_idx, "radius": radius, "limit": limit}
    r = requests.get(f"{RAG_BASE}/neighbors", params=params, timeout=TIMEOUT_S)
    r.raise_for_status()
    return json.dumps(r.json(), ensure_ascii=False)

@tool(description="Fetch specific chunks by ids. Returns JSON string.")
def get_by_ids(ids: List[str], app_name: str = "claims") -> str:
    r = requests.post(f"{RAG_BASE}/by_ids", params={"app_name": app_name}, json={"ids": ids}, timeout=TIMEOUT_S)
    r.raise_for_status()
    return json.dumps(r.json(), ensure_ascii=False)

@tool(description="Append a note/feedback/decision to Chroma via memory gateway. Returns JSON string.")
def save_memory(
    collection: str,
    text: str,
    app: str,
    module: Optional[str] = None,
    submodule: Optional[str] = None,
    flow: Optional[str] = None,
    subflow: Optional[str] = None,
    kind: str = "note",
    author: str = "agent",
) -> str:
    headers = {"X-Token": MEM_TOKEN}
    payload = {"collection": collection, "text": text, "app": app, "module": module, "submodule": submodule,
               "flow": flow, "subflow": subflow, "kind": kind, "author": author}
    r = requests.post(MEM_URL, json=payload, headers=headers, timeout=TIMEOUT_S)
    r.raise_for_status()
    return json.dumps(r.json(), ensure_ascii=False)

if __name__ == "__main__":
    mcp.run()
