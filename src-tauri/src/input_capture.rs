use rdev::{listen, Button, EventType, Key};
use std::collections::HashSet;
use std::thread;
use tauri::{AppHandle, Emitter};

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, serde::Serialize)]
struct InputEventPayload {
    event_type: String,
    label: String,
    timestamp: u128,
}

fn get_timestamp() -> u128 {
    let start = SystemTime::now();
    start
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_millis()
}

pub fn start_capture(app: AppHandle) {
    thread::spawn(move || {
        let mut last_click_time: Option<Instant> = None;
        let mut last_click_button: Option<Button> = None;
        let double_click_threshold = Duration::from_millis(300);

        let mut pressed_modifiers: HashSet<Key> = HashSet::new();
        let mut is_paused = false;

        // Drag detection state
        let mut drag_start_pos: Option<(f64, f64)> = None;
        let mut is_dragging = false;

        if let Err(error) = listen(move |event| {
            let timestamp = get_timestamp();
            let mut payloads = Vec::new();
            let event_name = event.name.clone();

            match event.event_type {
                EventType::MouseMove { x, y } => {
                    // Check drag threshold
                    if let Some((start_x, start_y)) = drag_start_pos {
                        if !is_dragging {
                            let dist = ((x - start_x).powi(2) + (y - start_y).powi(2)).sqrt();
                            if dist > 10.0 {
                                // 10px threshold
                                is_dragging = true;
                                if !is_paused {
                                    // Optionally emit DragStart
                                    if let Some(btn) = last_click_button {
                                        let btn_str = format!("{:?}", btn);
                                        payloads.push(InputEventPayload {
                                            event_type: "dragstart".to_string(),
                                            label: format!("@DragStart[{}]", btn_str),
                                            timestamp,
                                        });
                                    }
                                }
                            }
                        }
                    }

                    if !is_paused {
                        payloads.push(InputEventPayload {
                            event_type: "mousemove".to_string(),
                            label: format!("@MouseMove[{:.0}, {:.0}]", x, y),
                            timestamp,
                        });
                    }
                }
                EventType::ButtonPress(btn) => {
                    // Reset drag state - we need position but don't have it easily here without tracking.
                    // For now, let's rely on the next MouseMove to set the start position if needed,
                    // BUT since we check threshold against start_pos, we need a start_pos.
                    // Simple hack: We won't start tracking drag UNLESS we get a MouseMove after Click.
                    // But we need the ORIGINAL position.
                    // Let's rely on rdev's MouseMove x,y being sent frequently.
                    // Actually, rdev doesn't cache position.
                    // Improving drag logic: Use `match rdev::display_size()` is not mouse pos.
                    // We must track last_mouse_pos from MouseMove events.
                    // Since we are in the same closure, let's add `last_mouse_pos` state.

                    // Note: This requires last_mouse_pos to have been captured at least once.
                    // We'll skip setting drag_start_pos if we haven't seen a move yet.

                    if !is_paused {
                        let btn_str = format!("{:?}", btn);
                        payloads.push(InputEventPayload {
                            event_type: "mousedown".to_string(),
                            label: format!("@MouseDown[{}]", btn_str),
                            timestamp,
                        });
                    }

                    last_click_button = Some(btn);
                    is_dragging = false;
                    // To implement drag properly we need last_mouse_pos.
                    // See below modification to MouseMove to store it.
                }
                EventType::ButtonRelease(btn) => {
                    let btn_str = format!("{:?}", btn);

                    if !is_paused {
                        payloads.push(InputEventPayload {
                            event_type: "mouseup".to_string(),
                            label: format!("@MouseUp[{}]", btn_str),
                            timestamp,
                        });

                        if is_dragging {
                            payloads.push(InputEventPayload {
                                event_type: "drag".to_string(),
                                label: format!("@Drag[{}]", btn_str),
                                timestamp,
                            });
                        } else {
                            payloads.push(InputEventPayload {
                                event_type: "click".to_string(),
                                label: format!("@Click[{}]", btn_str),
                                timestamp,
                            });

                            let now = Instant::now();
                            if let (Some(last_time), Some(last_btn)) =
                                (last_click_time, last_click_button)
                            {
                                if last_btn == btn
                                    && now.duration_since(last_time) < double_click_threshold
                                {
                                    payloads.push(InputEventPayload {
                                        event_type: "doubleclick".to_string(),
                                        label: format!("@DoubleClick[{}]", btn_str),
                                        timestamp,
                                    });
                                }
                            }
                            last_click_time = Some(now);
                        }
                    }

                    drag_start_pos = None;
                    is_dragging = false;
                    last_click_button = Some(btn);
                }
                EventType::KeyPress(key) => {
                    if matches!(
                        key,
                        Key::ControlLeft
                            | Key::ControlRight
                            | Key::ShiftLeft
                            | Key::ShiftRight
                            | Key::Alt
                            | Key::MetaLeft
                            | Key::MetaRight
                    ) {
                        pressed_modifiers.insert(key);
                    }

                    let is_ctrl = pressed_modifiers.contains(&Key::ControlLeft)
                        || pressed_modifiers.contains(&Key::ControlRight);
                    let is_alt = pressed_modifiers.contains(&Key::Alt);
                    if is_ctrl && is_alt && key == Key::KeyP {
                        is_paused = !is_paused;
                        let status_label = if is_paused { "Paused" } else { "Resumed" };
                        let _ = app.emit(
                            "input-event",
                            InputEventPayload {
                                event_type: "system".to_string(),
                                label: format!("Capture {}", status_label),
                                timestamp,
                            },
                        );
                        return;
                    }

                    if !is_paused {
                        let mut key_parts: Vec<String> = Vec::new();

                        let is_shift = pressed_modifiers.contains(&Key::ShiftLeft)
                            || pressed_modifiers.contains(&Key::ShiftRight);
                        let is_meta = pressed_modifiers.contains(&Key::MetaLeft)
                            || pressed_modifiers.contains(&Key::MetaRight);

                        let is_modifier_key = matches!(
                            key,
                            Key::ControlLeft
                                | Key::ControlRight
                                | Key::ShiftLeft
                                | Key::ShiftRight
                                | Key::Alt
                                | Key::MetaLeft
                                | Key::MetaRight
                        );

                        let mut final_key_string = String::new();
                        let mut consumes_shift = false;

                        // Primary Strategy: Use OS-provided name if available and not a control char
                        // This handles JIS layout and Shift states auto-magically
                        if let Some(ref name) = event_name {
                            // Filter out control characters if necessary, though rdev usually returns None for pure modifiers
                            // But keeps things like Enter/Tab sometimes? Logs showed Escape -> \u{1b}
                            // Let's check string length and content.
                            // We want to use it for printable characters.
                            let is_control_char = name.chars().any(|c| c.is_control());

                            if !is_control_char && !name.is_empty() {
                                final_key_string = name.clone();
                                // If we use the OS name, implicit assumption is that it includes the shift state
                                // e.g. Shift+a -> "A". user wants just "A".
                                // So we say it consumes_shift.
                                consumes_shift = true;
                            }
                        }

                        // Exception: Space should be explicitly "Space"
                        if key == Key::Space {
                            final_key_string = "Space".to_string();
                            consumes_shift = false;
                        }

                        // Fallback Strategy: Manual Mapping (for control chars or when name is None)

                        // Helper closure for character mapping
                        // Returns Some((string, consumes_shift)) if mapped, None otherwise
                        let get_jis_char = |k: Key, shift: bool| -> Option<(String, bool)> {
                            match k {
                                Key::KeyA => {
                                    Some((if shift { "A" } else { "a" }.to_string(), true))
                                }
                                Key::KeyB => {
                                    Some((if shift { "B" } else { "b" }.to_string(), true))
                                }
                                Key::KeyC => {
                                    Some((if shift { "C" } else { "c" }.to_string(), true))
                                }
                                Key::KeyD => {
                                    Some((if shift { "D" } else { "d" }.to_string(), true))
                                }
                                Key::KeyE => {
                                    Some((if shift { "E" } else { "e" }.to_string(), true))
                                }
                                Key::KeyF => {
                                    Some((if shift { "F" } else { "f" }.to_string(), true))
                                }
                                Key::KeyG => {
                                    Some((if shift { "G" } else { "g" }.to_string(), true))
                                }
                                Key::KeyH => {
                                    Some((if shift { "H" } else { "h" }.to_string(), true))
                                }
                                Key::KeyI => {
                                    Some((if shift { "I" } else { "i" }.to_string(), true))
                                }
                                Key::KeyJ => {
                                    Some((if shift { "J" } else { "j" }.to_string(), true))
                                }
                                Key::KeyK => {
                                    Some((if shift { "K" } else { "k" }.to_string(), true))
                                }
                                Key::KeyL => {
                                    Some((if shift { "L" } else { "l" }.to_string(), true))
                                }
                                Key::KeyM => {
                                    Some((if shift { "M" } else { "m" }.to_string(), true))
                                }
                                Key::KeyN => {
                                    Some((if shift { "N" } else { "n" }.to_string(), true))
                                }
                                Key::KeyO => {
                                    Some((if shift { "O" } else { "o" }.to_string(), true))
                                }
                                Key::KeyP => {
                                    Some((if shift { "P" } else { "p" }.to_string(), true))
                                }
                                Key::KeyQ => {
                                    Some((if shift { "Q" } else { "q" }.to_string(), true))
                                }
                                Key::KeyR => {
                                    Some((if shift { "R" } else { "r" }.to_string(), true))
                                }
                                Key::KeyS => {
                                    Some((if shift { "S" } else { "s" }.to_string(), true))
                                }
                                Key::KeyT => {
                                    Some((if shift { "T" } else { "t" }.to_string(), true))
                                }
                                Key::KeyU => {
                                    Some((if shift { "U" } else { "u" }.to_string(), true))
                                }
                                Key::KeyV => {
                                    Some((if shift { "V" } else { "v" }.to_string(), true))
                                }
                                Key::KeyW => {
                                    Some((if shift { "W" } else { "w" }.to_string(), true))
                                }
                                Key::KeyX => {
                                    Some((if shift { "X" } else { "x" }.to_string(), true))
                                }
                                Key::KeyY => {
                                    Some((if shift { "Y" } else { "y" }.to_string(), true))
                                }
                                Key::KeyZ => {
                                    Some((if shift { "Z" } else { "z" }.to_string(), true))
                                }

                                // Common JIS Numbers
                                Key::Num1 => {
                                    Some((if shift { "!" } else { "1" }.to_string(), true))
                                }
                                Key::Num2 => {
                                    Some((if shift { "\"" } else { "2" }.to_string(), true))
                                }
                                Key::Num3 => {
                                    Some((if shift { "#" } else { "3" }.to_string(), true))
                                }
                                Key::Num4 => {
                                    Some((if shift { "$" } else { "4" }.to_string(), true))
                                }
                                Key::Num5 => {
                                    Some((if shift { "%" } else { "5" }.to_string(), true))
                                }
                                Key::Num6 => {
                                    Some((if shift { "&" } else { "6" }.to_string(), true))
                                }
                                Key::Num7 => {
                                    Some((if shift { "'" } else { "7" }.to_string(), true))
                                }
                                Key::Num8 => {
                                    Some((if shift { "(" } else { "8" }.to_string(), true))
                                }
                                Key::Num9 => {
                                    Some((if shift { ")" } else { "9" }.to_string(), true))
                                }
                                Key::Num0 => {
                                    Some((if shift { "0" } else { "0" }.to_string(), false))
                                }

                                // JIS Symbol Mappings
                                Key::BackQuote => {
                                    Some((if shift { "`" } else { "@" }.to_string(), true))
                                }
                                Key::LeftBracket => {
                                    Some((if shift { "{" } else { "[" }.to_string(), true))
                                }
                                Key::RightBracket => {
                                    Some((if shift { "}" } else { "]" }.to_string(), true))
                                }
                                Key::BackSlash => {
                                    Some((if shift { "}" } else { "]" }.to_string(), true))
                                }
                                Key::Quote => {
                                    Some((if shift { "*" } else { ":" }.to_string(), true))
                                }
                                Key::SemiColon => {
                                    Some((if shift { "+" } else { ";" }.to_string(), true))
                                }
                                Key::Comma => {
                                    Some((if shift { "<" } else { "," }.to_string(), true))
                                }
                                Key::Dot => Some((if shift { ">" } else { "." }.to_string(), true)),
                                Key::Slash => {
                                    Some((if shift { "?" } else { "/" }.to_string(), true))
                                }
                                Key::Minus => {
                                    Some((if shift { "=" } else { "-" }.to_string(), true))
                                }
                                Key::Equal => {
                                    Some((if shift { "~" } else { "^" }.to_string(), true))
                                }

                                // Standardize others
                                Key::Space => Some(("Space".to_string(), false)),
                                Key::Return => Some(("Enter".to_string(), false)),
                                Key::Backspace => Some(("Backspace".to_string(), false)),
                                Key::Tab => Some(("Tab".to_string(), false)),
                                Key::Escape => Some(("Esc".to_string(), false)),

                                _ => None,
                            }
                        };

                        let get_default_key_name = |k: Key| -> &str {
                            match k {
                                Key::KeyA => "A",
                                Key::KeyB => "B",
                                Key::KeyC => "C",
                                Key::KeyD => "D",
                                Key::KeyE => "E",
                                Key::KeyF => "F",
                                Key::KeyG => "G",
                                Key::KeyH => "H",
                                Key::KeyI => "I",
                                Key::KeyJ => "J",
                                Key::KeyK => "K",
                                Key::KeyL => "L",
                                Key::KeyM => "M",
                                Key::KeyN => "N",
                                Key::KeyO => "O",
                                Key::KeyP => "P",
                                Key::KeyQ => "Q",
                                Key::KeyR => "R",
                                Key::KeyS => "S",
                                Key::KeyT => "T",
                                Key::KeyU => "U",
                                Key::KeyV => "V",
                                Key::KeyW => "W",
                                Key::KeyX => "X",
                                Key::KeyY => "Y",
                                Key::KeyZ => "Z",
                                Key::Num1 => "1",
                                Key::Num2 => "2",
                                Key::Num3 => "3",
                                Key::Num4 => "4",
                                Key::Num5 => "5",
                                Key::Num6 => "6",
                                Key::Num7 => "7",
                                Key::Num8 => "8",
                                Key::Num9 => "9",
                                Key::Num0 => "0",
                                Key::Space => "Space",
                                Key::Return => "Enter",
                                Key::Backspace => "Backspace",
                                Key::Tab => "Tab",
                                Key::Escape => "Esc",
                                Key::UpArrow => "Up",
                                Key::DownArrow => "Down",
                                Key::LeftArrow => "Left",
                                Key::RightArrow => "Right",
                                Key::Minus => "-",
                                Key::Equal => "=",
                                Key::LeftBracket => "[",
                                Key::RightBracket => "]",
                                Key::BackSlash => "\\",
                                Key::SemiColon => ";",
                                Key::Quote => "'",
                                Key::BackQuote => "`",
                                Key::Comma => ",",
                                Key::Dot => ".",
                                Key::Slash => "/",
                                Key::F1 => "F1",
                                Key::F2 => "F2",
                                Key::F3 => "F3",
                                Key::F4 => "F4",
                                Key::F5 => "F5",
                                Key::F6 => "F6",
                                Key::F7 => "F7",
                                Key::F8 => "F8",
                                Key::F9 => "F9",
                                Key::F10 => "F10",
                                Key::F11 => "F11",
                                Key::F12 => "F12",
                                _ => "?",
                            }
                        };

                        if !is_modifier_key {
                            let has_other_modifiers = is_ctrl || is_alt || is_meta;
                            if !has_other_modifiers {
                                // Typewriter mode
                                if !final_key_string.is_empty() {
                                    // already set by event.name
                                } else if let Some((text, consumed)) = get_jis_char(key, is_shift) {
                                    final_key_string = text;
                                    consumes_shift = consumed && is_shift;
                                } else {
                                    final_key_string = get_default_key_name(key).to_string();
                                }
                            } else {
                                // Shortcut mode - use default uppercase/symbols
                                // E.g. Ctrl+S -> we want "Ctrl+S", usually name might be "s" or "S" or control-code
                                // For shortcuts, typically we want the Key name (e.g. "S"), not the produced char (which might be affected by ctrl)
                                // So we ignore event.name for Shortcuts and force default key name logic?
                                // OR we use default key name always for shortcuts.
                                final_key_string = get_default_key_name(key).to_string();
                                consumes_shift = false; // Shortcuts like Ctrl+Shift+S explicitely show Shift
                            }
                        }

                        if is_ctrl {
                            key_parts.push("Ctrl".to_string());
                        }
                        if is_alt {
                            key_parts.push("Alt".to_string());
                        }
                        if is_shift && !consumes_shift {
                            key_parts.push("Shift".to_string());
                        }
                        if is_meta {
                            key_parts.push("Meta".to_string());
                        }

                        if !is_modifier_key {
                            if final_key_string == "?" {
                                let s = format!("{:?}", key);
                                let clean_s = if s.starts_with("Key") && s.len() > 3 {
                                    s[3..].to_string()
                                } else {
                                    s
                                };
                                key_parts.push(clean_s);
                            } else {
                                key_parts.push(final_key_string);
                            }
                        } else if key_parts.is_empty() {
                            return;
                        }

                        if !key_parts.is_empty() {
                            let label = format!("@Key[{}]", key_parts.join("+"));
                            payloads.push(InputEventPayload {
                                event_type: "key".to_string(),
                                label,
                                timestamp,
                            });
                        }
                    }
                }
                EventType::KeyRelease(key) => {
                    if matches!(
                        key,
                        Key::ControlLeft
                            | Key::ControlRight
                            | Key::ShiftLeft
                            | Key::ShiftRight
                            | Key::Alt
                            | Key::MetaLeft
                            | Key::MetaRight
                    ) {
                        pressed_modifiers.remove(&key);
                    }
                }
                _ => {}
            }

            // Important: We need to capture MouseMove X,Y to use for drag start position later
            // However, we can't mutate drag_start_pos easily if it was None.
            // Let's modify the loop structure slightly to handle this.
            if let EventType::MouseMove { x, y } = event.event_type {
                // If we just pressed (drag_start_pos is None but button is pressed?), set it?
                // But drag_start_pos is reset on press/release.
                // We actually need to set drag_start_pos ON PRESS using current location.
                // But we don't have location on press.
                // So we set it on FIRST move after press.
                if last_click_button.is_some() && drag_start_pos.is_none() && !is_dragging {
                    drag_start_pos = Some((x, y));
                }
            }

            for p in payloads {
                let _ = app.emit("input-event", p);
            }
        }) {
            eprintln!("Input capture error: {:?}", error);
        }
    });
}
