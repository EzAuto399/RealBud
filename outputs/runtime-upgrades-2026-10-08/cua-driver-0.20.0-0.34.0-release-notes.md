=== cua-driver-rs-v0.34.0 2026-10-05T22:30:08Z
This release adds 2 features and includes 4 fixes.
## Features
- six agent cursor motion styles. ([#4659](https://github.com/trycua/cua/pull/4659))
- choose the cursor motion in start_session and a saved default. ([#4670](https://github.com/trycua/cua/pull/4670))
## Fixes
- prefer the owned macOS browser profile endpoint. ([#4384](https://github.com/trycua/cua/pull/4384)) Thanks @injaneity, @Irfanwani.
- keep Chromium tabs alive under gVisor on arm64. ([#4658](https://github.com/trycua/cua/pull/4658))
- draw the comet trail from the arrow's body, not its tip. ([#4673](https://github.com/trycua/cua/pull/4673))
- scope macOS health permission guidance. ([#4674](https://github.com/trycua/cua/pull/4674))
=== cua-driver-rs-v0.33.4 2026-10-05T06:04:19Z
This release includes 2 fixes.
## Fixes
- support multi-monitor Hyprland desktops. ([#4305](https://github.com/trycua/cua/pull/4305)) Thanks @Iann29, @CARLOSDAVID33; reported by @praxis1244-consulting.
- recognize captured Chinese browser consent. ([#4590](https://github.com/trycua/cua/pull/4590)) Thanks @loonghao.
=== cua-driver-rs-v0.33.3 2026-10-04T20:16:57Z
This release includes 3 fixes.
## Fixes
- settle started browser consent before claim completion. ([#4595](https://github.com/trycua/cua/pull/4595))
- drain committed consent work through timeout. ([#4595](https://github.com/trycua/cua/pull/4595))
- refuse set_value on Finder's Get Info Name field. ([#4614](https://github.com/trycua/cua/pull/4614)) Thanks @Ed-Key.
=== cua-driver-rs-v0.33.2 2026-10-04T14:54:59Z
This release includes 2 fixes.
## Fixes
- match "..." to the ellipsis in macOS menu paths. ([#4578](https://github.com/trycua/cua/pull/4578)) Thanks @Ed-Key.
- repair native Hyprland foreground regressions. ([#4396](https://github.com/trycua/cua/pull/4396))
=== cua-driver-rs-v0.33.1 2026-10-03T21:42:46Z
This release includes 16 fixes.
## Fixes
- drain Windows foreground input before restoring focus. ([#4500](https://github.com/trycua/cua/pull/4500)) Thanks @wszkxlllll.
- keep idle X11 cursor overlays unmapped. ([#4529](https://github.com/trycua/cua/pull/4529)) Thanks @Iflaqbhat.
- let verify_state read label-less display text on macOS. ([#4531](https://github.com/trycua/cua/pull/4531)) reported by @kianwoon.
- make the macOS background drag refusal explicit. ([#4533](https://github.com/trycua/cua/pull/4533)) reported by @kianwoon.
- omit AX-less AppKit helper windows from macOS list_windows. ([#4534](https://github.com/trycua/cua/pull/4534)) reported by @kianwoon.
- scrub the Claude MCP registration the CLI actually creates. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- keep the CLI fallback inside the ownership check. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- make Claude MCP cleanup path-owned. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- fail safely when Claude ownership cannot be inspected. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- make Windows MCP removal guidance ownership-safe. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- remove UTF-8 BOM from Windows uninstaller. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- close remaining Claude cleanup safety gaps. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- preserve foreign dangling launcher. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- reject relative MCP commands as ownership evidence. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- keep the uninstaller parseable by bash 3.2. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
- tie Claude MCP cleanup to actual release removal. ([#4546](https://github.com/trycua/cua/pull/4546)) Thanks @c8dhjp4tyv-bit.
=== cua-driver-rs-v0.33.0 2026-10-03T14:03:39Z
This release adds 2 features and includes 17 fixes.
## Features
- auto-link skills for Pi. ([#4049](https://github.com/trycua/cua/pull/4049)) Thanks @kvnloo; reported by @tyxlb.
- let embedding hosts set the macOS key gap. ([#3489](https://github.com/trycua/cua/pull/3489)) Thanks @hyprcat.
## Fixes
- accept verbatim and junctioned Windows browser installs. ([#4467](https://github.com/trycua/cua/pull/4467)) Thanks @qtqjcz.
- validate Windows capture handles. ([#4333](https://github.com/trycua/cua/pull/4333)) Thanks @AnvitDevadiga; reported by @ART1KZ.
- support rotated Hyprland outputs. ([#3969](https://github.com/trycua/cua/pull/3969)) Thanks @osamahbeig.
- report recoverable UIA timeouts as warnings. ([#3959](https://github.com/trycua/cua/pull/3959)) Thanks @lorenzozanee.
- point the macOS CDP-port error at browser_prepare, not launch_app flags. ([#2931](https://github.com/trycua/cua/pull/2931)) Thanks @biztex.
- rank titled macOS launch windows first. ([#4048](https://github.com/trycua/cua/pull/4048)) Thanks @Iflaqbhat; reported by @0xsline.
- refuse ambiguous macOS browser AppleScript. ([#4051](https://github.com/trycua/cua/pull/4051)) Thanks @kvnloo.
- constrain element_token tool schemas. ([#4318](https://github.com/trycua/cua/pull/4318)) Thanks @kvnloo.
- extend first Linux snapshot budget. ([#4375](https://github.com/trycua/cua/pull/4375)) Thanks @Iflaqbhat, @kvnloo.
- validate get_window_state window via exact Win32 lookup. ([#4505](https://github.com/trycua/cua/pull/4505)) reported by @nothingtolose09-sys.
- map Windows browser window rect into Chromium DIP layout. ([#4506](https://github.com/trycua/cua/pull/4506)) reported by @Feighery89.
- resolve sheet elements to their parent window. ([#4507](https://github.com/trycua/cua/pull/4507)) reported by @muness.
- re-resolve visible windows on a stale Space view. ([#4509](https://github.com/trycua/cua/pull/4509)) reported by @muness.
- deduplicate macOS browser setup identities. ([#4466](https://github.com/trycua/cua/pull/4466)) Thanks @Iflaqbhat.
- close the menu a failed macOS invoke_menu path opened. ([#4484](https://github.com/trycua/cua/pull/4484)) Thanks @Ed-Key.
- count an erroring macOS toggle press when its value moved. ([#4485](https://github.com/trycua/cua/pull/4485)) Thanks @Ed-Key.
- refuse set_value on Finder file name cells instead of confirming a rename that never happened. ([#4483](https://github.com/trycua/cua/pull/4483)) Thanks @Ed-Key.
=== cua-driver-rs-v0.32.0 2026-10-01T21:34:36Z
This release adds 1 features and includes 5 fixes.
## Features
- merge updated sdk from cua-staging. ([#4397](https://github.com/trycua/cua/pull/4397)) Thanks @injaneity, @r33drichards.
## Fixes
- run the cursor event loop when PiP is enabled. ([#4304](https://github.com/trycua/cua/pull/4304)) Thanks @ZenAlexa.
- keep Windows update --apply from killing its own installer. ([#4398](https://github.com/trycua/cua/pull/4398)) reported by @Feighery89.
- hash downloads with .NET instead of Get-FileHash. ([#4418](https://github.com/trycua/cua/pull/4418))
- list every windowed instance of a bundle in macOS list_apps. ([#4421](https://github.com/trycua/cua/pull/4421))
- attribute #4418 and #4421 in the 0.32.0 changelog. ([#4425](https://github.com/trycua/cua/pull/4425))
=== cua-driver-rs-v0.31.0 2026-09-30T16:46:18Z
This release includes 11 fixes.
## Fixes
- allow Hyprland foreground typing with Num Lock and keymap options. ([#3970](https://github.com/trycua/cua/pull/3970)) Thanks @osamahbeig, @spencerbull.
- ship the Hyprland plugin keyboard sources in release kits and test them in CI. ([#4310](https://github.com/trycua/cua/pull/4310))
- wait for a launching macOS app before its first snapshot. ([#4309](https://github.com/trycua/cua/pull/4309))
- report live running state for accessory apps. ([#3456](https://github.com/trycua/cua/pull/3456)) Thanks @xronocode.
- honor modifiers during X11 drags. ([#3618](https://github.com/trycua/cua/pull/3618)) Thanks @usedhonda.
- accept every Enter-key spelling in the Linux terminal gate. ([#3658](https://github.com/trycua/cua/pull/3658)) Thanks @bennybuoy.
- send a real key repeat rate on Hyprland agent keyboards. ([#4358](https://github.com/trycua/cua/pull/4358))
- keep the Windows autostart task when an isolated install or failed registration would remove it. ([#4284](https://github.com/trycua/cua/pull/4284)) Thanks @dajiaohuang.
- report native Wayland modified-drag refusals with a stable code. ([#4360](https://github.com/trycua/cua/pull/4360))
- reveal the agent cursor for keyboard-first actions. ([#4287](https://github.com/trycua/cua/pull/4287))
- resolve element tokens against a snapshot store invalidated on read. ([#3873](https://github.com/trycua/cua/pull/3873)) Thanks @r33drichards, @injaneity.
=== cua-driver-rs-v0.30.4 2026-09-28T21:38:51Z
This release includes 9 fixes.
## Fixes
- support fractionally scaled Hyprland desktops. ([#4244](https://github.com/trycua/cua/pull/4244)) Thanks @lorenzozanee; reported by @leeweisern.
- drop schemars uint/float formats from contract schema. ([#3462](https://github.com/trycua/cua/pull/3462)) Thanks @redreceipt.
- render browser cursor on Linux. ([#3778](https://github.com/trycua/cua/pull/3778))
- scope trajectory recording to the session that started it. ([#3632](https://github.com/trycua/cua/pull/3632)) Thanks @c8dhjp4tyv-bit; reported by @0p9b.
- keep a foreground key chord's modifiers on its base key. ([#3855](https://github.com/trycua/cua/pull/3855)) Thanks @will-bogusz.
- verify a raised window on its display, not global order. ([#3785](https://github.com/trycua/cua/pull/3785)) Thanks @will-bogusz.
- preserve delivered X11 mouse click timing. ([#3762](https://github.com/trycua/cua/pull/3762)) Thanks @steipete.
- anchor theme transforms at hotspot. ([#4246](https://github.com/trycua/cua/pull/4246)) Thanks @lorenzozanee; reported by @werinad.
- capture X11 DirectColor window colors. ([#3758](https://github.com/trycua/cua/pull/3758)) Thanks @steipete.
=== cua-driver-rs-v0.30.3 2026-09-28T14:00:06Z
This release includes 29 fixes.
## Fixes
- drop the boolean enum from verify_state for Gemini clients. ([#4229](https://github.com/trycua/cua/pull/4229)) Thanks @shobhitagnihotri69; reported by @artaidreams.
- let SDK hosts bound the post-action window poll. ([#3946](https://github.com/trycua/cua/pull/3946)) Thanks @will-bogusz.
- move fixed-size macOS windows with set_window_frame. ([#4133](https://github.com/trycua/cua/pull/4133)) Thanks @FredAmartey.
- invoke a menu on a window that is not already in front. ([#3781](https://github.com/trycua/cua/pull/3781)) Thanks @will-bogusz.
- scope codesign --strict to symlinks in isolated-launch check. ([#4059](https://github.com/trycua/cua/pull/4059)) Thanks @tylerbrevard, @the-laughing-monkey.
- lazily initialize macos clipboard. ([#3025](https://github.com/trycua/cua/pull/3025)) reported by @cxrlitxs.
- ignore daemon windows in change detection. ([#1784](https://github.com/trycua/cua/pull/1784)) Thanks @xronocode.
- skip Chromium targets without browser windows. ([#3541](https://github.com/trycua/cua/pull/3541)) Thanks @adamjosephargaman.
- skip unrepresentable Hyprland clients. ([#4250](https://github.com/trycua/cua/pull/4250)) Thanks @lorenzozanee, @siebertlanhove.
- map standalone Wayland modifier keys. ([#3659](https://github.com/trycua/cua/pull/3659)) Thanks @ceckert.
- keep the Windows daemon accepting after a failed pipe instance. ([#4279](https://github.com/trycua/cua/pull/4279)) Thanks @r33drichards.
- confirm X11 foreground actions that close a window when focus parks on the WM. ([#4248](https://github.com/trycua/cua/pull/4248)) Thanks @abonneth.
- report screenshot_frame_valid on successful Linux window captures. ([#3814](https://github.com/trycua/cua/pull/3814)) Thanks @will-bogusz.
- make Windows listener discovery locale independent. ([#3275](https://github.com/trycua/cua/pull/3275)) reported by @avdeg.
- parse Windows signer names that contain commas. ([#4273](https://github.com/trycua/cua/pull/4273))
- diagnose Windows SSH pipe access. ([#3318](https://github.com/trycua/cua/pull/3318)) reported by @fortitudedigitalservices-afk.
- self-elevate the Windows local uninstaller. ([#3178](https://github.com/trycua/cua/pull/3178))
- mark the left Windows key as extended. ([#4046](https://github.com/trycua/cua/pull/4046)) Thanks @ScoobyXD.
- resolve Windows shortcut environment targets. ([#3975](https://github.com/trycua/cua/pull/3975)) Thanks @steipete.
- report named Linux text fields' content as value. ([#4292](https://github.com/trycua/cua/pull/4292))
- report Linux kill_app success only after the process exits. ([#4281](https://github.com/trycua/cua/pull/4281)) Thanks @HsiangNianian.
- launch apps with a standard-user token from an elevated Windows Driver. ([#4282](https://github.com/trycua/cua/pull/4282))
- fail autostart enable when the UAC prompt is declined. ([#3180](https://github.com/trycua/cua/pull/3180))
- reject malformed tool arguments found by fuzzing. ([#3777](https://github.com/trycua/cua/pull/3777)) Thanks @r33drichards.
- handle consent for fresh browser claims. ([#3288](https://github.com/trycua/cua/pull/3288)) Thanks @loonghao.
- wait for a cold Chromium tree before the first snapshot. ([#3783](https://github.com/trycua/cua/pull/3783)) Thanks @will-bogusz.
- diagnose file-descriptor exhaustion during macOS browser inspection. ([#3889](https://github.com/trycua/cua/pull/3889)) Thanks @lorenzozanee.
- recreate an idle-reclaimed unnamed session on its next call. ([#4283](https://github.com/trycua/cua/pull/4283)) reported by @YOUKNOWWHOOO.
- keep schema properties named title or description. ([#3827](https://github.com/trycua/cua/pull/3827)) Thanks @LikelyLucid; reported by @will-bogusz.
## Performance
- skip verifier AX walk for screenshot evidence. ([#4164](https://github.com/trycua/cua/pull/4164)) Thanks @kvnloo.
=== cua-driver-rs-v0.30.2 2026-09-27T18:58:59Z
This release includes 1 fix.
## Fixes
- refresh the semantic page title after navigation. ([#4261](https://github.com/trycua/cua/pull/4261))
=== cua-driver-rs-v0.30.1 2026-09-26T19:45:40Z
This release includes 1 fix.
## Fixes
- launch isolated browsers de-elevated from an elevated Windows Driver. ([#4234](https://github.com/trycua/cua/pull/4234))
=== cua-driver-rs-v0.29.1 2026-09-25T20:12:49Z
This release includes 3 fixes.
## Fixes
- keep a macOS selection when pixel typing into a focused field. ([#4148](https://github.com/trycua/cua/pull/4148))
- finish Edge 153 session cleanup when its accessibility tree is briefly empty. ([#4158](https://github.com/trycua/cua/pull/4158))
- make macOS existing-profile browser setup finish reliably. ([#4160](https://github.com/trycua/cua/pull/4160))
=== cua-driver-rs-v0.28.3 2026-09-24T20:48:37Z
This release adds 3 features and includes 9 fixes.
## Features
- observe agent cursor moves/presses and report the system cursor shape. ([#3883](https://github.com/trycua/cua/pull/3883))
- add optional visual perception extension. ([#3943](https://github.com/trycua/cua/pull/3943))
- land background and foreground input on X11 desktops (OSWorld) and budget get_window_state walks on every platform. ([#3882](https://github.com/trycua/cua/pull/3882)) Thanks @abonneth.
## Fixes
- preserve observed X11 click identities. ([#3864](https://github.com/trycua/cua/pull/3864)) Thanks @tanishqkancharla.
- report surviving local install on uninstall. ([#3021](https://github.com/trycua/cua/pull/3021))
- stabilize Hyprland agent input. ([#3901](https://github.com/trycua/cua/pull/3901))
- hint foreground escalation on unavailable UIA clicks. ([#3888](https://github.com/trycua/cua/pull/3888)) Thanks @lorenzozanee.
- make skill workflows match runtime contracts. ([#3719](https://github.com/trycua/cua/pull/3719)) Thanks @ain3sh, @tshtark.
- report daemon_running accurately from socket liveness. ([#4019](https://github.com/trycua/cua/pull/4019)) Thanks @shobhitagnihotri69, @injaneity; reported by @0xsline.
- expose referenced MCP skill resources. ([#4028](https://github.com/trycua/cua/pull/4028))
- correlate Chromium profile window titles. ([#4030](https://github.com/trycua/cua/pull/4030)) Thanks @spencerbull.
- rotate the perception extension signing key. ([#4072](https://github.com/trycua/cua/pull/4072)) Thanks @abonneth.
=== cua-driver-rs-v0.28.2 2026-09-15T21:55:39Z
This release includes 4 fixes.
## Fixes
- preserve semantic Hyprland AX scrolling. ([#3820](https://github.com/trycua/cua/pull/3820))
- unify desktop snapshot identity and payload ownership. ([#3616](https://github.com/trycua/cua/pull/3616))
- capture macOS desktops without relying on PATH. ([#3755](https://github.com/trycua/cua/pull/3755))
- route background text through Hyprland input. ([#3877](https://github.com/trycua/cua/pull/3877))
=== cua-driver-rs-v0.28.1 2026-09-12T08:45:39Z
This release includes 5 fixes.
## Fixes
- report encoder exit and shutdown timeout errors. ([#3714](https://github.com/trycua/cua/pull/3714))
- link skills for fresh Codex and Claude installs. ([#3742](https://github.com/trycua/cua/pull/3742))
- exclude cursor overlay from foreground verification. ([#3704](https://github.com/trycua/cua/pull/3704))
- restore embedded-host builds on macOS and Linux. ([#3687](https://github.com/trycua/cua/pull/3687)) Thanks @AnthonyRonning, @injaneity.
- preserve X11 keyboard delivery and timing. ([#3761](https://github.com/trycua/cua/pull/3761)) Thanks @steipete.
=== cua-driver-rs-v0.28.0 2026-09-11T08:57:44Z
This release adds 1 feature.
## Features
- support modern stdio MCP and skills resources. ([#3609](https://github.com/trycua/cua/pull/3609)) Thanks @0xjohnnydev, @c8dhjp4tyv-bit.
=== cua-driver-rs-v0.27.0 2026-09-11T04:30:14Z
This release adds 1 features and includes 3 fixes.
## Features
- share typed MCP connection across language bindings. ([#3715](https://github.com/trycua/cua/pull/3715))
## Fixes
- eliminate duplicate Swift bridge symbols. ([#3680](https://github.com/trycua/cua/pull/3680)) Thanks @grishy.
- normalize repeated macOS consent labels. ([#3706](https://github.com/trycua/cua/pull/3706))
- retry safe Hyprland stale geometry refusals. ([#3732](https://github.com/trycua/cua/pull/3732))
=== cua-driver-rs-v0.26.1 2026-09-10T12:15:53Z
This release includes 1 fix.
## Fixes
- retain inert Hyprland pointer on desktop faults. ([#3702](https://github.com/trycua/cua/pull/3702))
=== cua-driver-rs-v0.26.0 2026-09-10T04:59:37Z
This release adds 2 features and includes 1 fixes.
## Features
- expose typed native-window SDK flow. ([#3683](https://github.com/trycua/cua/pull/3683))
- carry typed envelopes through opt-in MCP streams. ([#3692](https://github.com/trycua/cua/pull/3692))
## Fixes
- admit typed remote window observation. ([#3695](https://github.com/trycua/cua/pull/3695))
=== cua-driver-rs-v0.25.0 2026-09-09T07:45:11Z
This release adds 4 features and includes 5 fixes.
## Features
- add bounded typed guest envelope receiver. ([#3650](https://github.com/trycua/cua/pull/3650))
- expose foreign remote envelope channels. ([#3651](https://github.com/trycua/cua/pull/3651))
- add private loopback envelope HTTP carrier. ([#3653](https://github.com/trycua/cua/pull/3653))
- integrate typed Driver access with Fleet Sandbox. ([#3654](https://github.com/trycua/cua/pull/3654))
## Fixes
- read macOS browser checkbox state. ([#3404](https://github.com/trycua/cua/pull/3404))
- leave pacman-managed updates to pacman. ([#3636](https://github.com/trycua/cua/pull/3636))
- correct macos click delivery and recording evidence. ([#2907](https://github.com/trycua/cua/pull/2907))
- recover slow Windows UIA health probes. ([#3109](https://github.com/trycua/cua/pull/3109)) reported by @jonathanljs.
- preserve unavailable Windows UIA clicks. ([#3671](https://github.com/trycua/cua/pull/3671))
=== cua-driver-rs-v0.24.0 2026-09-07T16:51:50Z
This release adds 3 features and includes 7 fixes.
## Features
- let get_window_state skip the a11y tree and return capture metadata. ([#3516](https://github.com/trycua/cua/pull/3516))
- expose action names in get_window_state elements. ([#3617](https://github.com/trycua/cua/pull/3617)) Thanks @hqhq1025, @Wangxiaoxiaoa.
- add qualified Hyprland isolated input. ([#3572](https://github.com/trycua/cua/pull/3572)) Thanks @LikelyLucid, @rodrimora, @shuv1337.
## Fixes
- accept host identity in embedded health check. ([#2170](https://github.com/trycua/cua/pull/2170))
- persist macOS direct capture verification. ([#2904](https://github.com/trycua/cua/pull/2904))
- authenticate history requests lazily. ([#3505](https://github.com/trycua/cua/pull/3505)) reported by @0xble.
- support Bedrock browser prepare schema. ([#3311](https://github.com/trycua/cua/pull/3311)) reported by @adam0thman.
- drain daemon state on shutdown. ([#3348](https://github.com/trycua/cua/pull/3348))
- verify native Hyprland capture and observation. ([#3557](https://github.com/trycua/cua/pull/3557)) Thanks @LikelyLucid, @RodriMora, @shuv1337.
- recover owned orphaned X11 master devices. ([#3601](https://github.com/trycua/cua/pull/3601)) reported by @jeffjhunter.
## Performance
- read the macOS product version in-process in health_report. ([#3491](https://github.com/trycua/cua/pull/3491)) Thanks @hyprcat.
=== cua-driver-rs-v0.23.2 2026-08-31T11:02:46Z
This release includes 1 fix.
## Fixes
- clean up unresolved Chrome consent UI. ([#3468](https://github.com/trycua/cua/pull/3468))
=== cua-driver-rs-v0.22.2 2026-08-27T18:45:58Z
This release includes 2 fixes.
## Fixes
- report macOS Retina backing scale. ([#3328](https://github.com/trycua/cua/pull/3328)) Thanks @HsiangNianian; reported by @Jandos22.
- align Wayland capture, focus, and overlays. ([#3152](https://github.com/trycua/cua/pull/3152)) Thanks @jacob-vincent-mink, @spencerbull.
=== cua-driver-rs-v0.22.1 2026-08-25T23:50:58Z
This release includes 1 fix.
## Fixes
- clean up Chromium remote debugging after browser sessions. ([#3372](https://github.com/trycua/cua/pull/3372))
=== cua-driver-rs-v0.22.0 2026-08-24T16:44:46Z
This release adds 1 features and includes 8 fixes.
## Features
- configure embedded daemon overlay. ([#3280](https://github.com/trycua/cua/pull/3280))
## Fixes
- make Windows browser prepare language independent. ([#3135](https://github.com/trycua/cua/pull/3135)) Thanks @loonghao.
- block uinput pointer hotplug on KDE X11. ([#2888](https://github.com/trycua/cua/pull/2888)) Thanks @Berzerker5653.
- preserve embedded telemetry preference. ([#3277](https://github.com/trycua/cua/pull/3277))
- reset stale local TCC rows after ad-hoc rebuilds. ([#2747](https://github.com/trycua/cua/pull/2747))
- honor HERMES_HOME for skill links. ([#3291](https://github.com/trycua/cua/pull/3291))
- normalize legacy dispatch before authorization. ([#3037](https://github.com/trycua/cua/pull/3037)) Thanks @ngnichtel.
- preserve TCC across release updates. ([#3297](https://github.com/trycua/cua/pull/3297)) reported by @LacBang.
- match canonical Windows executable paths. ([#3299](https://github.com/trycua/cua/pull/3299)) Thanks @HsiangNianian; reported by @lars-hv.
=== cua-driver-rs-v0.21.0 2026-08-19T21:37:21Z
This release adds 2 features and includes 10 fixes.
## Features
- Project Centennial preview. ([#3188](https://github.com/trycua/cua/pull/3188))
- extend Project Centennial across desktop platforms. ([#3189](https://github.com/trycua/cua/pull/3189))
## Fixes
- refuse unproven Wayland window capture. ([#3200](https://github.com/trycua/cua/pull/3200)) reported by @AksharP5.
- drop the stale 0.17 version from element_index messages. ([#3202](https://github.com/trycua/cua/pull/3202))
- launch isolated browser without pid. ([#3208](https://github.com/trycua/cua/pull/3208))
- strip UTF-8 BOM from uninstall.ps1. ([#3176](https://github.com/trycua/cua/pull/3176))
- tell operators to reconnect agent sessions after history enable. ([#3224](https://github.com/trycua/cua/pull/3224))
- attribute hosted Windows apps by window. ([#3227](https://github.com/trycua/cua/pull/3227))
- tolerate missing local autostart task. ([#3229](https://github.com/trycua/cua/pull/3229))
- harden consented existing-profile attachment. ([#3211](https://github.com/trycua/cua/pull/3211))
- preserve history admission on macOS relaunch. ([#3245](https://github.com/trycua/cua/pull/3245))
- admit stable local history signatures. ([#3262](https://github.com/trycua/cua/pull/3262))
=== cua-driver-rs-v0.20.0 2026-08-15T18:02:03Z
This release adds 5 features and includes 8 fixes.
## Features
- add implicit lifecycle sessions. ([#3013](https://github.com/trycua/cua/pull/3013)) reported by @cxrlitxs.
- apply capability manifests across permission profiles. ([#3015](https://github.com/trycua/cua/pull/3015))
- add immutable Driver and Lume nightly releases. ([#3097](https://github.com/trycua/cua/pull/3097))
- add persistent Driver and Lume release channels. ([#3102](https://github.com/trycua/cua/pull/3102))
- remove browser approval tokens. ([#3185](https://github.com/trycua/cua/pull/3185))
## Fixes
- align agent guidance with lifecycle sessions. ([#3041](https://github.com/trycua/cua/pull/3041))
- verify foreground focus before input. ([#3068](https://github.com/trycua/cua/pull/3068))
- stage current skill pack on Windows local installs. ([#3083](https://github.com/trycua/cua/pull/3083))
- reject misplaced MCP permission flags. ([#3085](https://github.com/trycua/cua/pull/3085))
- preserve direct MCP session ownership. ([#3079](https://github.com/trycua/cua/pull/3079))
- write the update-check cache to the canonical home. ([#3032](https://github.com/trycua/cua/pull/3032)) Thanks @rsyuzyov.
- hide policy-disabled MCP tools. ([#3132](https://github.com/trycua/cua/pull/3132)) Thanks @r33drichards.
- preserve named CLI sessions. ([#3144](https://github.com/trycua/cua/pull/3144))