import asyncio, json, os, requests
from mcp.server import Server
from mcp.types import Tool, ToolRequest, ToolResponse, TextContent

RAG_BASE = os.environ.get("RAG_BASE", "http://127.0.0.1:8091")  # points to hybrid_retrieval_api.py server
MEM_URL  = os.environ.get("MEM_URL", "http://127.0.0.1:8080/memory/append")
MEM_TOKEN= os.environ.get("MEM_TOKEN", "super-secret-token")

server = Server("rag-tools")

@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="retrieve_hybrid",
            description="Hybrid retrieve (TF-IDF→SVD vectors + BM25). Returns JSON with chunks.",
            inputSchema={"type":"object","required":["q"],"properties":{
                "q":{"type":"string"},
                "app_name":{"type":"string","default":"claims"},
                "top_k":{"type":"integer","default":8},
                "pool":{"type":"integer","default":50}
            }}
        ),
        Tool(
            name="get_neighbors",
            description="Fetch ±radius neighbor chunks from the same file.",
            inputSchema={"type":"object","required":["source_path","seq_idx"],"properties":{
                "app_name":{"type":"string","default":"claims"},
                "source_path":{"type":"string"},
                "seq_idx":{"type":"integer"},
                "radius":{"type":"integer","default":1},
                "limit":{"type":"integer","default":10}
            }}
        ),
        Tool(
            name="get_by_ids",
            description="Fetch specific chunks by id list.",
            inputSchema={"type":"object","required":["ids"],"properties":{
                "app_name":{"type":"string","default":"claims"},
                "ids":{"type":"array","items":{"type":"string"}}
            }}
        ),
        Tool(
            name="save_memory",
            description="Append note/feedback/decision into Chroma via gateway.",
            inputSchema={"type":"object","required":["collection","text","app"],"properties":{
                "collection":{"type":"string"},
                "text":{"type":"string"},
                "app":{"type":"string"},
                "module":{"type":"string"},
                "submodule":{"type":"string"},
                "flow":{"type":"string"},
                "subflow":{"type":"string"},
                "kind":{"type":"string","default":"note"},
                "author":{"type":"string","default":"agent"}
            }}
        )
    ]

@server.call_tool()
async def call_tool(req: ToolRequest):
    try:
        if req.name == "retrieve_hybrid":
            r = requests.get(f"{RAG_BASE}/retrieve", params=req.arguments or {}, timeout=60)
            r.raise_for_status()
            return ToolResponse(content=[TextContent(type="text", text=json.dumps(r.json(), ensure_ascii=False))])

        if req.name == "get_neighbors":
            r = requests.get(f"{RAG_BASE}/neighbors", params=req.arguments or {}, timeout=30)
            r.raise_for_status()
            return ToolResponse(content=[TextContent(type="text", text=json.dumps(r.json(), ensure_ascii=False))])

        if req.name == "get_by_ids":
            args = req.arguments or {}
            app_name = args.get("app_name","claims")
            ids = args.get("ids",[])
            r = requests.post(f"{RAG_BASE}/by_ids", params={"app_name": app_name}, json={"ids": ids}, timeout=30)
            r.raise_for_status()
            return ToolResponse(content=[TextContent(type="text", text=json.dumps(r.json(), ensure_ascii=False))])

        if req.name == "save_memory":
            headers={"X-Token": MEM_TOKEN}
            r = requests.post(MEM_URL, json=req.arguments or {}, headers=headers, timeout=30)
            r.raise_for_status()
            return ToolResponse(content=[TextContent(type="text", text=json.dumps(r.json(), ensure_ascii=False))])

        return ToolResponse(isError=True, content=[TextContent(type="text", text="Unknown tool")])
    except Exception as e:
        return ToolResponse(isError=True, content=[TextContent(type="text", text=f"Tool error: {e}")])


def main():
    from mcp.server.stdio import stdio_server
    asyncio.run(stdio_server(server).serve())

if __name__ == "__main__":
    main()
