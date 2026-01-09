import EventOverlay from "./components/Overlay/EventOverlay";
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

function App() {
  useEffect(() => {
    // Initial setup: Ignore cursor events for the whole window by default via Rust if possible,
    // but controlling it from frontend via specific elements is more flexible.
    // For now, let's start with allowing events so we can click the filter button.
    const appWindow = getCurrentWindow();
    // Use a small timeout to ensure the window is fully ready and transparency is applied
    setTimeout(() => {
      appWindow.setIgnoreCursorEvents(true).catch(console.error);
    }, 100);
  }, []);


  return (
    <div className="w-screen h-screen relative bg-transparent overflow-hidden">
      {/* Background info layer - purely visual, should be ignored */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 hover:opacity-100 transition-opacity duration-500">
        <div className="text-center p-4 rounded-xl bg-gray-900/50 backdrop-blur-sm border border-white/10">
          <h1 className="text-3xl font-bold text-white/50 select-none">TraceCap</h1>
          <p className="text-white/30 select-none">Overlay Active</p>
        </div>
      </div>

      {/* Interactive layer wrapper */}
      {/* Any child component that wants to be clickable must wrapped or handle events to toggle ignore cursor */}
      <EventOverlay />
    </div>
  );
}

export default App;
