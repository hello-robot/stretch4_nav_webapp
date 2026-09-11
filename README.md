# Stretch4 Nav Webapp

Standalone web UI for Stretch 4 **mapping**, **map editing** (occupancy / keepout /
speed zones / named rooms, plus crop & rotate), and **navigation**. The app runs on the robot, you can open it from any browser on the same network.

---

## Requirements

| Need | Check it with |
|---|---|
| ROS 2 Jazzy with `stretch_nav2` built | `ros2 pkg list \| grep stretch_nav2` |
| `rosbridge_suite` | `ros2 pkg list \| grep rosbridge` |
| Python 3.10+ | `python3 --version` |

If `rosbridge_suite` is missing:

```bash
sudo apt install ros-jazzy-rosbridge-server
```

---

## Install

```bash
pip3 install --user hello-robot-stretch4-nav-webapp
```

The web UI ships prebuilt inside the package.

> **Use `--user`, not a virtualenv.** The app needs `rclpy` — which comes
> from the robot's ROS install, never from pip. A `--user` install
> lives in the robot's system Python and can see it.
### Run it

```bash
stretch4-nav-webapp
```

Then open **http://\<robot-ip\>:8080** from any browser on the same network
(`hostname -I` on the robot gives you the IP).

That single command starts the API, serves the UI, and launches rosbridge.
Everything else — mapping, navigation, the camera — is started from buttons in
the UI.

### Updating later

```bash
pip3 install --user --upgrade hello-robot-stretch4-nav-webapp
# then restart stretch4-nav-webapp
```

To run the code from a git checkout instead, see [Developing](#developing).

---

## CLI flags

```bash
stretch4-nav-webapp                                   # normal: UI on :8080, rosbridge on :9090
stretch4-nav-webapp --port 9000                       # serve the UI on a different port
stretch4-nav-webapp --rosbridge-port 9091             # move rosbridge
stretch4-nav-webapp --maps-dir ~/my_maps              # use a different maps folder
stretch4-nav-webapp --config ~/my_config.yaml         # use a different config file entirely
stretch4-nav-webapp --print-config-path               # where the default config lives, then exit
stretch4-nav-webapp --no-rosbridge                    # you already run rosbridge yourself
stretch4-nav-webapp --host 127.0.0.1                  # local-only, no network access

# Skip the UI and start a mode immediately:
stretch4-nav-webapp --mapping
stretch4-nav-webapp --navigation my_map_name
stretch4-nav-webapp --edit_map my_map_name
```

Flags always win over the config file.

---

## Configuration

One YAML file holds everything worth editing. Every setting below is safe to
change; the app re-reads it on restart.

### Ports and paths

```yaml
ui_port: 8080          # where the web UI is served
rosbridge_port: 9090   # the WebSocket the browser subscribes to ROS through
maps_dir: null         # null = $HELLO_FLEET_PATH/maps, else ~/stretch_user/maps
host: "0.0.0.0"        # 0.0.0.0 = reachable from other machines; 127.0.0.1 = robot only
```

- **Change `ui_port`** if something else already owns 8080. The browser URL
  changes with it; nothing else does.
- **Change `maps_dir`** to point at a different map library, e.g.
  `maps_dir: "/home/hello-robot/shared_maps"`. The folder is created if missing.
- **Leave `host` at `0.0.0.0`** unless you specifically want the UI unreachable
  from other machines.

### Launch commands

These are the exact `ros2 launch` commands the mode buttons run. The `{braces}`
are filled in by the app before it runs them.

```yaml
launches:
  mapping: "ros2 launch stretch_nav2 offline_mapping.launch.py use_rviz:={use_rviz}"
  navigation: "ros2 launch stretch_nav2 navigation_mppi.launch.py map:={map_yaml} use_rviz:={use_rviz}"
  navigation_filters: "ros2 launch stretch_nav2 navigation_mppi_keepout.launch.py map:={map_yaml} keepout_mask:={keepout_yaml} speed_mask:={speed_yaml} enable_keepout:={enable_keepout} enable_speed:={enable_speed} use_rviz:={use_rviz}"
  rosbridge: "ros2 run rosbridge_server rosbridge_websocket --ros-args -p port:={rosbridge_port} ..."

use_rviz: "false"      # set "true" to also open RViz alongside the web UI
```

### Using your own config file

The default config lives inside the installed package. Copy it out, edit the
copy, and point the app at it — that way an upgrade never overwrites your
changes:

```bash
cp "$(stretch4-nav-webapp --print-config-path)" ~/my_config.yaml
# edit ~/my_config.yaml
stretch4-nav-webapp --config ~/my_config.yaml
```

---

## Modes

| Button | What it starts | What you see |
|--------|----------------|--------------|
| **Mapping** | `stretch_nav2 offline_mapping.launch.py` | Live map building as you drive with the gamepad |
| **Edit Map** | Nothing on the robot — file editing only | Paint tools for occupancy / keepout / speed / semantic / binary filter, plus crop & rotate |
| **Navigation** | Nav2 MPPI (+ keepout/speed filters if enabled) | Map, robot, lidar, costmaps, planned path, footprint |

Only **one mode runs at a time** — starting one stops the previous one.

Both robot viewers are top-down and mirror the stock Stretch RViz displays. The **Layers** checkboxes hide overlays without stopping the data.

---

## Where maps live

Under `$HELLO_FLEET_PATH/maps` (fallback `~/stretch_user/maps`), one folder per map:

```
maps/<map_name>/
  map.pgm + map.yaml            The occupancy map itself
  keepout.pgm + keepout.yaml    No-go zones (black = blocked)
  speed.pgm + speed.yaml        Slow zones (darker = slower)
  semantic.png + semantic.yaml  Which room each cell belongs to
  semantic.json                 The room names and colours
  binary_filter_mask.pgm + .yaml   Areas for a binary filter you launch yourself
  locations.json                Saved places you can send the robot to
  .before_transform/            One undo step for crop & rotate
```

---

## Keepout, speed & rooms

Edit Map paints four kinds of zone onto a saved map:

- **Keepout** — the robot will not enter, at all.
- **Speed** — the robot slows down; darker paint = slower.
- **Rooms** — you name an area ("Kitchen") and paint where it is.
- **Binary filter** — areas for a binary filter you launch yourself. Drawn here,
  never launched here.

Switch keepout and speed on when you start Navigation. That's when the app picks
the `navigation_filters` launch instead of the plain one. See the
[Nav2 keepout tutorial](https://docs.nav2.org/tutorials/docs/navigation2_with_keepout_filter.html)
for what Nav2 does with them.

### Binary filter (draw here, launch yourself)

There is a fourth mask, **Binary filter**, and it is deliberately different: the
app only *draws* it. Navigation from the app has no binary switch and never starts a filter
for it, because a binary filter is only half a feature, the other half is the
node you write that reacts to `/binary_state` (turn something on, play a sound,
stop the arm). What should happen in a marked area is yours to define.

What the app writes:

```
maps/<map_name>/binary_filter_mask.pgm     255 everywhere, 153 where you painted
maps/<map_name>/binary_filter_mask.yaml    mode: scale, free_thresh 0.0, occupied_thresh 1.0
```

Point your own `filter_mask_server` at that yaml. With the usual
`base: 0.0`, `multiplier: 1.0`, `flip_threshold: 10.0`, any pixel darker than
about 229 flips the state, 153 is the grey used in the app.

It is cropped and rotated along with every other layer, so it stays registered
against the map.

### What the speed percentage means

The slider is the share of full speed the robot **keeps**: 80% means it drives at
80% of its normal speed there. That holds as long as the robot's speed filter is
configured `base: 100.0`, `multiplier: -1.0` (in `stretch_nav2`'s
`nav2_filter_servers.yaml`).

The slider stops at 5%, not 0%. Nav2 reads a speed limit of exactly zero as *"no
limit"*, so a pure-black speed zone would make the robot drive at **full** speed
through it. To forbid an area outright, paint it on the keepout layer instead.

---

## Crop & rotate

**Edit Map → Crop & rotate** (available on the Occupancy layer) reshapes the
whole map. It is not a paint tool:

- **Keep inside** trims the map to the selection; **Remove inside** clears the
  selection back to blank (unknown / no-restriction) and keeps the map size.
- Rotation previews live on the canvas; nothing is written until Apply.
- Every layer — occupancy, keepout, speed, rooms, binary — is transformed
  together, so the masks stay registered against the map.
- Saved locations are moved to match, so a location on the kitchen door is still
  on the kitchen door afterwards.
- One undo step is kept, in `.before_transform/`.

---

## Developing

For changing the code rather than just running it. Needs Node 18+
(`node --version`) on top of the requirements above, because here you build the
UI yourself instead of getting it prebuilt from PyPI.

```bash
git clone https://github.com/hello-robot/stretch4_nav_webapp
cd stretch4_nav_webapp

pip3 install --user -e .          # editable: runs the clone in place

cd frontend
npm install
npm run build                     # writes stretch4_nav_webapp/static
cd ..

stretch4-nav-webapp
```

> **The UI is served from `stretch4_nav_webapp/static`, not from
> `frontend/src`.** If you change anything under `frontend/src` and skip
> `npm run build`, the browser keeps showing the old version.

Tests:

```bash
python3 -m pytest
```

---

## Adding a new mode

1. Create `stretch4_nav_webapp/modes/my_mode.py`:

```python
from stretch4_nav_webapp.modes.base import Mode, ModeContext, register, shlex_split_launch

@register
class MyMode(Mode):
    id = "my_mode"
    label = "My Mode"
    description = "Does something useful."
    needs_robot = True

    def start(self, ctx: ModeContext, **kwargs) -> dict:
        cmd = shlex_split_launch("ros2 launch my_pkg my.launch.py")
        ctx.process_manager.set_active_mode(self.id, cmd)
        return {"ok": True, "mode": self.id, "command": cmd}
```

2. Import it from `stretch4_nav_webapp/modes/__init__.py` so it registers itself.
3. Add a page and a button in `frontend/src/App.jsx` that calls
   `api('/api/modes/my_mode/start', { method: 'POST', body: '{}' })`.
4. Rebuild the frontend and restart `stretch4-nav-webapp`. The mode also shows up in
   `GET /api/modes`.

---

## API

The same endpoints the UI buttons use.

**Modes**
- `GET /api/status` — active mode, ports, maps folder, process table
- `POST /api/modes/{mapping|navigation|edit_map}/start` — accepts
  `{"map_name": "...", "use_keepout": true, "use_speed": true}` and
  `{"skip_readiness": true}` to bypass the homed/stowed/dongle guardrail
- `POST /api/modes/stop`

**Robot**
- `GET /api/robot/readiness` — homed, stowed, battery, runstop, dongle, in-flight action
- `POST /api/robot/home` · `POST /api/robot/stow` — start the routine, returns immediately
- `POST /api/robot/runstop` `{"engaged": true|false}` — the safety stop
- `POST /api/robot/gamepad/start`

**Navigation**
- `POST /api/navigation/goal` `{"x":…, "y":…, "yaw":…}`
- `POST /api/navigation/cancel`
- `POST /api/navigation/initial_pose` — tell the robot where it is
- `POST /api/navigation/undock`

**Maps**
- `POST /api/mapping/save` `{"name": "..."}`
- `GET /api/maps`
- `GET|POST /api/maps/{name}/layer/{occupancy|keepout|speed|semantic|binary}`
- `GET|PUT /api/maps/{name}/locations`
- `GET|PUT /api/maps/{name}/semantic` — room names/colours
- `GET|POST /api/maps/{name}/transform` · `POST /api/maps/{name}/transform/undo`

**Camera**
- `GET /api/camera/status` · `POST /api/camera/start` · `POST /api/camera/stop`

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| UI loads, robot never moves | Runstop engaged — the banner over the map has a Release button |
| Mode starts but the map stays empty | Give it ~30 s. If the Driver/Lidar chips go red, stop and restart the mode |
| Robot shown in the wrong place | Use **Set pose** to tell it where it actually is |
| Your UI change didn't appear | Working from source and `npm run build` wasn't run |
| `Address already in use` | Something else owns 8080 — use `--port` or change `ui_port` |
| Camera panel stuck on "Waiting for video" | Normal for 20–30 s. Longer means the driver failed — check `/tmp/stretch4_nav_webapp_camera.log` |


Every process the app starts writes its output to `/tmp/`:

```
/tmp/stretch4_nav_webapp_mode_navigation.log
/tmp/stretch4_nav_webapp_mode_mapping.log
/tmp/stretch4_nav_webapp_rosbridge.log
/tmp/stretch4_nav_webapp_camera.log
/tmp/stretch4_nav_webapp_gamepad.log
/tmp/stretch4_nav_webapp_body_server.log
```

That's the first place to look when something won't start — it holds the real
`ros2 launch` output, errors included.
