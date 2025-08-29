// src/states/review.ts
import * as vscode from "vscode";
import * as YAML from "yaml";
import { TextDecoder, TextEncoder } from "util";
import { StateCard, StateCandidate } from "./stateTypes";

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();

async function loadCandidates(ws: vscode.Uri): Promise<StateCandidate[]> {
  try {
    const buf = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(ws, ".qa-cache", "state-cards.candidates.json")
    );
    return JSON.parse(dec.decode(buf));
  } catch {
    return [];
  }
}

async function writeYaml(ws: vscode.Uri, rel: string, obj: any) {
  const uri = vscode.Uri.joinPath(ws, rel);
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(ws, rel.split("/").slice(0, -1).join("/"))
  );
  await vscode.workspace.fs.writeFile(uri, enc.encode(YAML.stringify(obj)));
}

export async function cmdStatesReview() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) {
    vscode.window.showErrorMessage("Open a workspace.");
    return;
  }

  const props = await readProperties(ws);
  const appKey = props.appKey || props.AppID || "default";

  const cands = await loadCandidates(ws);
  if (!cands.length) {
    vscode.window.showWarningMessage(
      "No state candidates. Run `qa.states.bootstrap` first."
    );
    return;
  }

  while (true) {
    const pick = await vscode.window.showQuickPick(
      cands.map((c) => ({
        label: c.id,
        description: `inbound=${c.telemetry?.inbound ?? 0} • aliases=${(
          c.aliases ?? []
        )
          .slice(0, 3)
          .join(", ")}`,
        detail: `controls=${(c.topControls ?? []).slice(0, 4).join(", ")}`,
        c,
      })),
      { placeHolder: "Pick a candidate to promote (Esc to stop)" }
    );
    if (!pick) break;

    const c = (pick as any).c as StateCandidate;
    const name = await vscode.window.showInputBox({
      prompt: "Confirm card id",
      value: c.id,
    });
    if (!name) continue;

    // Minimal promoted card (trim candidates-only fields)
    const card: StateCard = {
      id: name,
      appKeys: [appKey],
      facets: c.facets,
      aliases: c.aliases?.slice(0, 8),
      variants: c.variants.slice(0, 3),
      domSignature: {
        tokens: (c.domSignature?.tokens ?? []).slice(0, 80),
        attrs: (c.domSignature?.attrs ?? []).slice(0, 20),
      },
      widgets: c.widgets?.slice(0, 8),
      topControls: c.topControls?.slice(0, 8),
      validators: c.validators,
      telemetry: c.telemetry,
    };

    const rel = `profiles/${appKey}/states/${sanitizeFile(name)}.yaml`;
    await writeYaml(ws, rel, card);
    vscode.window.showInformationMessage(`Promoted: ${name} → ${rel}`);
  }
}

function sanitizeFile(id: string) {
  return id.replace(/[^\w.\-]+/g, "_");
}

async function readProperties(ws: vscode.Uri): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const buf = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(ws, "app.properties")
    );
    const text = new TextDecoder().decode(buf);
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.+)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}
