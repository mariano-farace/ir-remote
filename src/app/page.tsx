/**
 * The three-panel workspace shell. Phase 1 provides the layout regions only;
 * the sidebar, chat, and editor panels are filled in by their own tasks.
 */
export default function Home() {
  return (
    <div className="workspace-grid">
      <aside className="workspace-panel border-r" aria-label="Scripts" />
      <section className="workspace-panel border-r" aria-label="Conversation" />
      <main className="workspace-panel" aria-label="Editor" />
    </div>
  );
}
