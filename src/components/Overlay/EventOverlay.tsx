import { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, availableMonitors, currentMonitor, Monitor as TauriMonitor } from '@tauri-apps/api/window';
import {
  MousePointer2, Keyboard, Monitor, X,
  AlignLeft, AlignRight
} from 'lucide-react';

interface InputEventPayload {
  event_type: 'mousemove' | 'mousedown' | 'mouseup' | 'click' | 'doubleclick' | 'key' | 'system' | 'dragstart' | 'drag';
  label: string;
  timestamp: number;
}

interface LogItem {
  id: number;
  payload: InputEventPayload;
  count: number;
  isTypingSequence?: boolean;
}

interface AppSettings {
  position: 'left' | 'right';
  keyboardLayout: 'US' | 'JIS';
  doubleClickThreshold: number;
  monitorName?: string;
}

export default function EventOverlay() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [permission, setPermission] = useState<boolean | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const [monitors, setMonitors] = useState<TauriMonitor[]>([]);
  const [currentMonitorName, setCurrentMonitorName] = useState<string>('');

  // Settings
  const [filters, setFilters] = useState({
    mousemove: true, mousedown: true, mouseup: true, click: true,
    doubleclick: true, key: true, system: true, drag: true, dragstart: false
  });
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('echocast-settings');
    return saved ? JSON.parse(saved) : { position: 'right', keyboardLayout: 'US', doubleClickThreshold: 300 };
  });

  const [showSettings, setShowSettings] = useState(false);
  const showSettingsRef = useRef(showSettings);

  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  useEffect(() => {
    localStorage.setItem('echocast-settings', JSON.stringify(settings));
    // TODO: Send settings to Rust backend here (especially keyboard layout and double click threshold)
  }, [settings]);

  // Initial permission check
  useEffect(() => {
    // Check permission
    checkPermission();

    // Load available monitors
    availableMonitors().then(async (list) => {
      setMonitors(list);

      const current = await currentMonitor();
      if (current) {
        setCurrentMonitorName(current.name || `Monitor ${list.indexOf(current) + 1}`);
      }
    });
  }, []);

  const changeMonitor = async (monitorName: string) => {
    const target = monitors.find(m => (m.name || `Monitor ${monitors.indexOf(m) + 1}`) === monitorName);
    if (!target) return;

    try {
      const appWindow = getCurrentWindow();
      // Unmaximize first to allow moving
      await appWindow.unmaximize();

      // Delay to allow unmaximize to settle
      setTimeout(async () => {
        await appWindow.setPosition(target.position);

        // Delay to allow move to settle
        setTimeout(async () => {
          await appWindow.maximize();
          setCurrentMonitorName(monitorName);
        }, 500);
      }, 200);

    } catch (e) {
      console.error("Failed to move window", e);
    }
  };

  // Sync transparency with settings visibility and update when position changes to ensure interactivity
  useEffect(() => {
    const updateIgnore = (ignore: boolean) => invoke('set_ignore_cursor_events', { ignore }).catch(console.error);

    updateIgnore(!showSettings);

    // Re-apply after layout transition (350ms) to ensure OS hit-test regions are updated
    if (showSettings) {
      const timer = setTimeout(() => {
        updateIgnore(false);
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [showSettings, settings.position]);

  // Listen for toggle-settings shortcut
  useEffect(() => {
    const unlistenTogglePromise = listen('toggle-settings', () => {
      setShowSettings(prev => {
        const next = !prev;
        if (next) setLogs([]); // Clear logs when opening settings
        return next;
      });
    });

    return () => {
      unlistenTogglePromise.then(u => u());
    }
  }, []);

  const checkPermission = async () => {
    try {
      const hasPermission = await invoke<boolean>('check_accessibility_permission');
      setPermission(hasPermission);
      if (!hasPermission) await invoke('request_accessibility_permission');
    } catch (e) {
      console.error("Failed to check permission", e);
    }
  };

  useEffect(() => {
    const unlistenPromise = listen<InputEventPayload>('input-event', (event) => {
      // Pause log updates while settings are open
      if (showSettingsRef.current) return;

      const newEvent = event.payload;

      setLogs(prevLogs => {
        const lastLog = prevLogs[prevLogs.length - 1];

        // MouseMove optimization
        if (newEvent.event_type === 'mousemove' && lastLog?.payload.event_type === 'mousemove') {
          return [...prevLogs.slice(0, -1), { ...lastLog, payload: newEvent, count: lastLog.count + 1 }];
        }

        // Key combo optimization
        if (newEvent.event_type === 'key') {
          const newLabel = newEvent.label.replace(/^@key\[/i, '').replace(/\]$/, '');
          const lastLabel = lastLog?.payload.label.replace(/^@key\[/i, '').replace(/\]$/, '');

          if (lastLog?.payload.event_type === 'key' && lastLog.payload.label === newEvent.label) {
            return [...prevLogs.slice(0, -1), { ...lastLog, count: lastLog.count + 1 }];
          }

          const isTextKey = (lbl: string) => /^[a-zA-Z0-9]$/.test(lbl);
          if (lastLog?.payload.event_type === 'key' && isTextKey(newLabel) && lastLog.isTypingSequence) {
            const currentContent = lastLabel;
            const updatedLabel = `@Key[${currentContent}${newLabel}]`;
            return [...prevLogs.slice(0, -1), { ...lastLog, payload: { ...lastLog.payload, label: updatedLabel, timestamp: newEvent.timestamp }, count: 1 }];
          }

          const isNewTypingSequence = isTextKey(newLabel);
          const newLog = { id: Date.now() + Math.random(), payload: newEvent, count: 1, isTypingSequence: isNewTypingSequence };
          const newLogs = [...prevLogs, newLog];
          return newLogs.length > 20 ? newLogs.slice(newLogs.length - 20) : newLogs;
        }

        // Click Cleanup Logic
        if (newEvent.event_type === 'click') {
          const btnMatch = newEvent.label.match(/\[(.*?)\]/);
          const btnName = btnMatch ? btnMatch[1] : null;
          if (btnName) {
            const clickPattern = new RegExp(`\\[${btnName}\\]`);
            const cleanedLogs = prevLogs.filter(log => {
              if (newEvent.timestamp - log.payload.timestamp > 500) return true;
              const type = log.payload.event_type;
              if (['mousedown', 'mouseup'].includes(type) && log.payload.label.match(clickPattern)) return false;
              return true;
            });
            return [...cleanedLogs, { id: Date.now() + Math.random(), payload: newEvent, count: 1 }];
          }
        }

        // DoubleClick Cleanup Logic
        if (newEvent.event_type === 'doubleclick') {
          const btnMatch = newEvent.label.match(/\[(.*?)\]/);
          const btnName = btnMatch ? btnMatch[1] : null;
          if (btnName) {
            const clickPattern = new RegExp(`\\[${btnName}\\]`);
            const cleanedLogs = prevLogs.filter(log => {
              if (newEvent.timestamp - log.payload.timestamp > 500) return true;
              const type = log.payload.event_type;
              if (['click', 'mousedown', 'mouseup'].includes(type) && log.payload.label.match(clickPattern)) return false;
              return true;
            });
            return [...cleanedLogs, { id: Date.now() + Math.random(), payload: newEvent, count: 1 }];
          }
        }

        // Normal Add
        const newLog = { id: Date.now() + Math.random(), payload: newEvent, count: 1 };
        const newLogs = [...prevLogs, newLog];
        return newLogs.length > 20 ? newLogs.slice(newLogs.length - 20) : newLogs;
      });
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const getIcon = (type: string) => {
    switch (type) {
      case 'mousemove': return <MousePointer2 className="w-4 h-4 text-gray-400 shrink-0" />;
      case 'mousedown': return <MousePointer2 className="w-4 h-4 text-orange-400 shrink-0 rotate-180" />;
      case 'mouseup': return <MousePointer2 className="w-4 h-4 text-blue-300 shrink-0" />;
      case 'click': return <MousePointer2 className="w-4 h-4 text-green-400 shrink-0" />;
      case 'doubleclick': return <div className="flex"><MousePointer2 className="w-4 h-4 text-purple-400 shrink-0" /><MousePointer2 className="w-4 h-4 text-purple-400 shrink-0 -ml-2" /></div>;
      case 'key': return <Keyboard className="w-4 h-4 text-yellow-400 shrink-0" />;
      case 'system': return <Monitor className="w-4 h-4 text-red-400 shrink-0" />;
      case 'dragstart': return <MousePointer2 className="w-4 h-4 text-pink-400 shrink-0 opacity-50" />;
      case 'drag': return <MousePointer2 className="w-4 h-4 text-pink-500 shrink-0" />;
      default: return <Monitor className="w-4 h-4 text-white shrink-0" />;
    }
  };

  const getBorderColor = (type: string) => {
    switch (type) {
      case 'mousemove': return 'border-l-4 border-l-gray-500/50';
      case 'mousedown': return 'border-l-4 border-l-orange-500';
      case 'mouseup': return 'border-l-4 border-l-blue-500';
      case 'click': return 'border-l-4 border-l-green-500';
      case 'doubleclick': return 'border-l-4 border-l-purple-500 ring-1 ring-purple-500/30';
      case 'key': return 'border-l-4 border-l-yellow-500';
      case 'system': return 'border-l-4 border-l-red-500 bg-red-950/30';
      case 'dragstart': return 'border-l-4 border-l-pink-500/50';
      case 'drag': return 'border-l-4 border-l-pink-500 ring-1 ring-pink-500/30';
      default: return 'border-l-4 border-l-white';
    }
  };

  const getDisplayLabel = (payload: InputEventPayload) => {
    let content = payload.label.replace(/^@.*?\[/, '').replace(/\]$/, '');

    // JIS Keyboard Correction
    // (Disabled: Backend now handles OS-resolved names)

    return content;
  };

  const containerPosition = settings.position === 'right' ? 'right-4 items-end' : 'left-4 items-start';
  const transformOrigin = settings.position === 'right' ? 'bottom right' : 'bottom left';
  const slideAnimation = settings.position === 'right' ? 'slide-in-from-right-8' : 'slide-in-from-left-8';

  return (
    <div className={`fixed bottom-4 ${containerPosition} flex flex-col gap-2 pointer-events-none transition-all duration-300`}>
      {/* Permission Warning */}
      {permission === false && (
        <div className="bg-red-500/80 text-white p-3 rounded-lg mb-2 backdrop-blur-sm pointer-events-auto cursor-pointer" onClick={() => invoke('request_accessibility_permission')}>
          ⚠️ Accessibility Permission Required (Click to Request)
        </div>
      )}

      {/* Settings Toggle */}
      {/* Close Settings Button (Only visible when settings are open) */}
      {showSettings && (
        <div className="pointer-events-auto mb-1 flex gap-2 items-center">
          <button
            onClick={() => setShowSettings(false)}
            className="
              text-xs bg-red-500/80 hover:bg-red-600/90 text-white
              p-2 rounded-full backdrop-blur-sm transition-all shadow-lg border border-red-400/30
            "
            title="Close Settings"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Settings Panel */}
      {showSettings && (
        <div
          className={`
            bg-gray-950/80 text-gray-200 p-4 rounded-xl backdrop-blur-xl border border-white/10 
            pointer-events-auto mb-2 text-xs shadow-2xl w-64
            animate-in fade-in zoom-in-95 slide-in-from-bottom-2
          `}
          onMouseEnter={() => invoke('set_ignore_cursor_events', { ignore: false }).catch(() => { })}
          onMouseLeave={() => {
            // Do not reset ignore if settings are open
          }}
        >
          <div className="space-y-4">

            {/* Position */}
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Position</div>
              <div className="flex bg-gray-900/50 p-1 rounded-lg border border-white/5">
                <button
                  onClick={() => setSettings(s => ({ ...s, position: 'left' }))}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md transition-all ${settings.position === 'left' ? 'bg-blue-600 shadow-sm text-white' : 'hover:bg-white/5 text-gray-400'}`}
                >
                  <AlignLeft className="w-3 h-3" /> Left
                </button>
                <button
                  onClick={() => setSettings(s => ({ ...s, position: 'right' }))}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md transition-all ${settings.position === 'right' ? 'bg-blue-600 shadow-sm text-white' : 'hover:bg-white/5 text-gray-400'}`}
                >
                  <AlignRight className="w-3 h-3" /> Right
                </button>
              </div>
            </div>

            {/* Keyboard Layout */}
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Keyboard Layout</div>
              <div className="flex bg-gray-900/50 p-1 rounded-lg border border-white/5">
                <button
                  onClick={() => setSettings(s => ({ ...s, keyboardLayout: 'US' }))}
                  className={`flex-1 py-1.5 rounded-md transition-all ${settings.keyboardLayout === 'US' ? 'bg-blue-600 shadow-sm text-white' : 'hover:bg-white/5 text-gray-400'}`}
                >
                  US (ANSI)
                </button>
                <button
                  onClick={() => setSettings(s => ({ ...s, keyboardLayout: 'JIS' }))}
                  className={`flex-1 py-1.5 rounded-md transition-all ${settings.keyboardLayout === 'JIS' ? 'bg-blue-600 shadow-sm text-white' : 'hover:bg-white/5 text-gray-400'}`}
                >
                  JIS (ISO)
                </button>
              </div>
            </div>

            {/* Monitor Selection */}
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Target Monitor</div>
              <div className="flex flex-col gap-1 bg-gray-900/50 p-1 rounded-lg border border-white/5">
                {monitors.map((m, idx) => {
                  const name = m.name || `Monitor ${idx + 1}`;
                  const isActive = name === currentMonitorName;
                  return (
                    <button
                      key={idx}
                      onClick={() => changeMonitor(name)}
                      className={`
                        text-left text-[11px] px-2 py-1.5 rounded transition-colors truncate
                        ${isActive ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-white/5'}
                      `}
                    >
                      {name} <span className="text-gray-500 text-[9px] ml-1">({m.size.width}x{m.size.height})</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Double Click Threshold */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-[10px] uppercase tracking-wider text-gray-500 font-bold">
                <span>Double Click Speed</span>
                <span className="text-blue-400">{settings.doubleClickThreshold}ms</span>
              </div>
              <input
                type="range"
                min="150" max="500" step="10"
                value={settings.doubleClickThreshold}
                onChange={(e) => setSettings(s => ({ ...s, doubleClickThreshold: Number(e.target.value) }))}
                className="w-full h-1.5 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>

            {/* Filters */}
            <div className="space-y-2 pt-2 border-t border-white/5">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">Event Filters</div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { key: 'mousemove', label: 'Mouse Move', icon: MousePointer2, color: 'text-gray-400' },
                  { key: 'click', label: 'Click', icon: MousePointer2, color: 'text-green-400' },
                  { key: 'doubleclick', label: 'Dbl Click', icon: MousePointer2, color: 'text-purple-400' },
                  { key: 'key', label: 'Keyboard', icon: Keyboard, color: 'text-yellow-400' },
                  { key: 'drag', label: 'Drag', icon: MousePointer2, color: 'text-pink-500' },
                  { key: 'system', label: 'System', icon: Monitor, color: 'text-red-400' },
                ].map(({ key, label, icon: Icon, color }) => (
                  <label key={key} className={`flex items-center gap-2 cursor-pointer select-none text-[11px] p-1.5 rounded hover:bg-white/5 transition-colors ${!filters[key as keyof typeof filters] ? 'opacity-50' : ''}`}>
                    <div className={`w-3 h-3 rounded-full border flex items-center justify-center ${filters[key as keyof typeof filters] ? 'bg-blue-500 border-blue-500' : 'border-gray-600'}`}>
                      {filters[key as keyof typeof filters] && <div className="w-1.5 h-1.5 bg-white rounded-full" />}
                    </div>
                    {/* Native checkbox hidden */}
                    <input
                      type="checkbox"
                      className="hidden"
                      checked={filters[key as keyof typeof filters]}
                      onChange={(e) => setFilters(prev => ({ ...prev, [key]: e.target.checked }))}
                    />
                    <Icon className={`w-3 h-3 ${color}`} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Logs */}
      <div className={`flex flex-col gap-2 w-80 perspective-1000 ${settings.position === 'left' ? 'items-start' : 'items-end'}`}>
        {logs.filter(log => filters[log.payload.event_type as keyof typeof filters]).map((log, index) => {
          const isLatest = index === logs.length - 1;
          return (
            <div
              key={log.id}
              className={`
                relative overflow-hidden
                bg-gray-950/70 text-gray-100 
                p-3 rounded-xl shadow-2xl 
                backdrop-blur-xl border border-white/5
                flex items-center justify-between 
                transition-all duration-300 ease-out
                animate-in ${slideAnimation} fade-in zoom-in-95
                ${getBorderColor(log.payload.event_type)}
                hover:bg-gray-900/90 w-full
            `}
              style={{
                boxShadow: '0 4px 30px rgba(0, 0, 0, 0.1)',
                transformOrigin: transformOrigin
              }}
            >
              {/* Glow effect */}
              <div className="absolute inset-0 bg-gradient-to-r from-white/5 to-transparent opacity-0 hover:opacity-100 transition-opacity pointer-events-none" />

              <div className="flex items-center gap-3 overflow-hidden z-10">
                <div className={`p-1.5 rounded-lg bg-white/5 ${isLatest ? 'animate-pulse' : ''}`}>
                  {getIcon(log.payload.event_type)}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-mono text-xs font-bold truncate text-white/90 tracking-wide" title={log.payload.label}>
                    {getDisplayLabel(log.payload)}
                  </span>
                  <span className="text-[10px] text-gray-400 capitalize">{log.payload.event_type}</span>
                </div>
              </div>

              {log.count > 1 && (
                <div className="flex flex-col items-center justify-center min-w-[24px] z-10">
                  <span className="bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[10px] px-2 py-0.5 rounded-full font-bold">
                    ×{log.count}
                  </span>
                </div>
              )}

              {/* Progress bar for auto-dismiss (visual only for now) */}
              <div className="absolute bottom-0 left-0 h-[2px] bg-gradient-to-r from-blue-500/50 to-transparent w-full opacity-30" />
            </div>
          )
        })}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
