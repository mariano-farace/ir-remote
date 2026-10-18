import { ChatPanel } from "@/components/chat/ChatPanel";
import { ScriptEditor } from "@/components/editor/ScriptEditor";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { WorkspaceProvider } from "@/components/workspace/useWorkspace";

/**
 * The three-panel workspace shell (T036).
 *
 * The panels are landmarks in their own right — `navigation` for the script
 * library, `region` for the conversation, `main` for the editor — and the
 * grid in `globals.css` places them. The shell holds no state of its own: the
 * document lives in `src/stores/document-store.ts` (Principle III).
 */
export default function Workspace() {
  return (
    <WorkspaceProvider>
      <div className="workspace-grid">
        <Sidebar />
        <ChatPanel />
        <ScriptEditor />
      </div>
    </WorkspaceProvider>
  );
}
