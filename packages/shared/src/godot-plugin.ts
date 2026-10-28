// The Godot editor plugin the app ships (issue #10): a "Locks" dock that
// shows the session's locks inside Godot or Summer Engine, warns when the
// open scene is locked by someone else (and again if you save it anyway),
// and asks the app to lock or release the open scene. Project setup writes
// it into addons/collab_tool/ and turns it on in project.godot. The app
// keeps .godot/collab_tool/locks.json up to date and reads the requests the
// plugin writes next to it. While the editor has the project open, the plugin
// also keeps .godot/collab_tool/editor.json fresh, so the app knows which
// editor (Godot or Summer Engine) is open and where its program is. .godot/
// is never committed.

export const GODOT_PLUGIN_DIR = 'addons/collab_tool';
export const GODOT_PLUGIN_CFG_PATH = `${GODOT_PLUGIN_DIR}/plugin.cfg`;
export const GODOT_PLUGIN_SCRIPT_PATH = `${GODOT_PLUGIN_DIR}/plugin.gd`;
/** Where the app writes the session's locks, and where the plugin writes its requests (in the Godot project folder). */
export const GODOT_LOCKS_FILE = '.godot/collab_tool/locks.json';
export const GODOT_REQUESTS_FILE = '.godot/collab_tool/requests.jsonl';
/** Rewritten every few seconds by the plugin while the editor has the project open; removed when it closes. */
export const GODOT_EDITOR_FILE = '.godot/collab_tool/editor.json';
/** The plugin writes the editor file this often; older than a few beats means the editor is gone. */
export const GODOT_EDITOR_BEAT_S = 2;

export const GODOT_PLUGIN_CFG = `[plugin]

name="Foreus"
description="Shows the session's file locks in the editor, and locks the open scene."
author="Foreus"
version="1.1"
script="plugin.gd"
`;

export const GODOT_PLUGIN_SCRIPT = `@tool
extends EditorPlugin

# Foreus: shows the session's file locks inside the
# editor, warns before you change a scene or resource someone else holds,
# and lets you lock or release the open scene. The app writes the locks to
# .godot/collab_tool/locks.json (never committed) and reads requests from
# .godot/collab_tool/requests.jsonl. editor.json tells the app the editor
# has the project open. Written by the app's project setup.

const DIR := "res://.godot/collab_tool/"
const LOCKS := DIR + "locks.json"
const REQUESTS := DIR + "requests.jsonl"
const EDITOR := DIR + "editor.json"

var _dock: VBoxContainer
var _status: Label
var _warning: Label
var _list: ItemList
var _lock_button: Button
var _timer: Timer
var _stamp := 0
var _locks: Array = []
var _you := ""
var _connected := false
var _warned := {}


func _enter_tree() -> void:
	_dock = VBoxContainer.new()
	_dock.name = "Locks"
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_dock.add_child(_status)
	_warning = Label.new()
	_warning.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_warning.add_theme_color_override("font_color", Color(1.0, 0.45, 0.4))
	_warning.visible = false
	_dock.add_child(_warning)
	_lock_button = Button.new()
	_lock_button.text = "Lock this scene"
	_lock_button.pressed.connect(_on_lock_pressed)
	_dock.add_child(_lock_button)
	_list = ItemList.new()
	_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_list.custom_minimum_size = Vector2(0, 160)
	_dock.add_child(_list)
	add_control_to_dock(DOCK_SLOT_RIGHT_BL, _dock)
	_timer = Timer.new()
	_timer.wait_time = 2.0
	_timer.autostart = true
	_timer.timeout.connect(_refresh)
	_dock.add_child(_timer)
	scene_changed.connect(func(_root: Node) -> void: _show())
	resource_saved.connect(_on_resource_saved)
	_refresh()


func _exit_tree() -> void:
	DirAccess.remove_absolute(ProjectSettings.globalize_path(EDITOR))
	if _dock:
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null


func _beat() -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(DIR))
	var file := FileAccess.open(ProjectSettings.globalize_path(EDITOR), FileAccess.WRITE)
	if file == null:
		return
	var program := OS.get_executable_path()
	file.store_string(JSON.stringify({
		"editor": "summer" if program.get_file().to_lower().contains("summer") else "godot",
		"program": program,
		"version": str(Engine.get_version_info().get("string", "")),
		"pid": OS.get_process_id(),
		"scene": _current_scene(),
		"at": int(Time.get_unix_time_from_system()),
	}))
	file.close()


func _refresh() -> void:
	_beat()
	var path := ProjectSettings.globalize_path(LOCKS)
	if not FileAccess.file_exists(path):
		_connected = false
		_locks = []
		_show()
		return
	var stamp := FileAccess.get_modified_time(path)
	if stamp == _stamp:
		_show()
		return
	_stamp = stamp
	var data = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(data) != TYPE_DICTIONARY:
		return
	_you = str(data.get("you", ""))
	_locks = data.get("locks", [])
	_connected = bool(data.get("connected", false))
	_show()


func _lock_for(res_path: String) -> Dictionary:
	for lock in _locks:
		if str(lock.get("path", "")).to_lower() == res_path.to_lower():
			return lock
	return {}


func _current_scene() -> String:
	var root := EditorInterface.get_edited_scene_root()
	return root.scene_file_path if root else ""


func _show() -> void:
	if not _dock:
		return
	_status.text = ("Locks in the session, as %s." % _you) if _connected else "Not connected: open Foreus and join the session."
	_list.clear()
	for lock in _locks:
		var line: String = "%s  %s%s" % [str(lock.get("path", "")), str(lock.get("holder", "")), " (exclusive)" if lock.get("exclusive", false) else ""]
		var index := _list.add_item(line)
		if lock.get("mine", false):
			_list.set_item_custom_fg_color(index, Color(0.5, 0.8, 1.0))
		if lock.get("reason", ""):
			_list.set_item_tooltip(index, str(lock.get("reason")))
	var scene := _current_scene()
	var lock: Dictionary = _lock_for(scene) if scene != "" else {}
	var others: bool = not lock.is_empty() and not lock.get("mine", false)
	_warning.visible = others
	if others:
		_warning.text = "%s is locked by %s. Changes you save here will clash with theirs." % [scene, str(lock.get("holder", ""))]
		if not _warned.has(scene):
			_warned[scene] = true
			push_warning("Foreus: " + _warning.text)
	_lock_button.disabled = scene == "" or not _connected or others
	_lock_button.text = "Release this scene" if (not lock.is_empty() and lock.get("mine", false)) else "Lock this scene"


func _on_lock_pressed() -> void:
	var scene := _current_scene()
	if scene == "":
		return
	var lock: Dictionary = _lock_for(scene)
	var action: String = "release" if (not lock.is_empty() and lock.get("mine", false)) else "lock"
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(DIR))
	var path := ProjectSettings.globalize_path(REQUESTS)
	var file := FileAccess.open(path, FileAccess.READ_WRITE if FileAccess.file_exists(path) else FileAccess.WRITE)
	if file == null:
		push_error("Foreus: could not write %s" % path)
		return
	file.seek_end()
	file.store_line(JSON.stringify({"action": action, "path": scene}))
	file.close()
	_status.text = "Asked the app to %s %s…" % [action, scene]


func _on_resource_saved(resource: Resource) -> void:
	var path := resource.resource_path
	var lock: Dictionary = _lock_for(path)
	if lock.is_empty() or lock.get("mine", false):
		return
	var dialog := AcceptDialog.new()
	dialog.title = "Locked by %s" % str(lock.get("holder", ""))
	dialog.dialog_text = "You saved %s, but %s holds its lock%s. Your changes will clash with theirs: talk to them before you commit it." % [path, str(lock.get("holder", "")), (" for \\"%s\\"" % lock.get("reason")) if lock.get("reason", "") else ""]
	EditorInterface.get_base_control().add_child(dialog)
	dialog.confirmed.connect(dialog.queue_free)
	dialog.popup_centered()
`;

const ENABLED_ENTRY = `"res://${GODOT_PLUGIN_CFG_PATH}"`;

/** The plugin is turned on in project.godot. */
export function pluginEnabled(projectGodot: string | null): boolean {
  return !!projectGodot && /^enabled\s*=\s*PackedStringArray\([^)]*res:\/\/addons\/collab_tool\/plugin\.cfg/m.test(projectGodot);
}

/** project.godot with the plugin turned on; the rest of the file stays as it was. */
export function withPluginEnabled(projectGodot: string): string {
  const text = projectGodot.replace(/\r\n/g, '\n');
  if (pluginEnabled(text)) return text;
  const section = /^\[editor_plugins\][ \t]*$/m.exec(text);
  if (section) {
    const after = text.slice(section.index);
    const enabled = /^enabled\s*=\s*PackedStringArray\(([^)]*)\)/m.exec(after);
    // Only the [editor_plugins] section's own line counts.
    const next = after.slice(1).search(/^\[/m);
    if (enabled && (next < 0 || enabled.index < next + 1)) {
      const list = enabled[1]!.trim();
      const line = `enabled=PackedStringArray(${list ? `${list}, ` : ''}${ENABLED_ENTRY})`;
      return text.slice(0, section.index) + after.replace(enabled[0], line);
    }
    const head = section.index + section[0].length;
    return `${text.slice(0, head)}\n\nenabled=PackedStringArray(${ENABLED_ENTRY})${text.slice(head)}`;
  }
  return `${text.trimEnd()}\n\n[editor_plugins]\n\nenabled=PackedStringArray(${ENABLED_ENTRY})\n`;
}

/** What the app writes to GODOT_LOCKS_FILE. */
export interface EditorLocks {
  /** Your name in the session. */
  you: string;
  connected: boolean;
  locks: { path: string; holder: string; exclusive: boolean; mine: boolean; reason: string }[];
}

/** What the plugin writes to GODOT_EDITOR_FILE. */
export interface EditorHeartbeat {
  editor: 'godot' | 'summer';
  /** The editor's program, which can run the game's tests too. */
  program: string;
  version: string;
  pid: number;
  /** The open scene (res://), or empty. */
  scene: string;
  /** Unix seconds. */
  at: number;
}

export function parseEditorHeartbeat(text: string): EditorHeartbeat | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if ((v.editor !== 'godot' && v.editor !== 'summer') || typeof v.at !== 'number') return null;
    return {
      editor: v.editor,
      program: typeof v.program === 'string' ? v.program : '',
      version: typeof v.version === 'string' ? v.version : '',
      pid: typeof v.pid === 'number' ? v.pid : 0,
      scene: typeof v.scene === 'string' ? v.scene : '',
      at: v.at,
    };
  } catch {
    return null;
  }
}

/** One line of GODOT_REQUESTS_FILE. */
export interface EditorRequest {
  action: 'lock' | 'release';
  /** A res:// path. */
  path: string;
}

export function parseEditorRequests(text: string): EditorRequest[] {
  const out: EditorRequest[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as { action?: unknown; path?: unknown };
      if ((value.action === 'lock' || value.action === 'release') && typeof value.path === 'string' && /^res:\/\//.test(value.path)) {
        out.push({ action: value.action, path: value.path });
      }
    } catch {
      // A half-written or empty line.
    }
  }
  return out;
}
