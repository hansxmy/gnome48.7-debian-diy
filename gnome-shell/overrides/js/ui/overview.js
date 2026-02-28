import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Signals from '../misc/signals.js';

// Time for initial animation going into Overview mode;
// this is defined here to make it available in imports.
export const ANIMATION_TIME = 200;

import * as DND from './dnd.js';
import * as Dash from './dash.js';
import * as LayoutManager from './layout.js';
import * as Main from './main.js';
import * as OverviewControls from './overviewControls.js';
import * as SwipeTracker from './swipeTracker.js';
import * as WindowManager from './windowManager.js';
import * as WorkspaceThumbnail from './workspaceThumbnail.js';

const DND_WINDOW_SWITCH_TIMEOUT = 750;

const OVERVIEW_ACTIVATION_TIMEOUT = 0.5;
const PERSISTENT_DASH_MAX_HEIGHT_RATIO = 0.128;
const PERSISTENT_DASH_BOTTOM_MARGIN = 8;
const PERSISTENT_DASH_ANIMATION_TIME = 140;

const OverviewActor = GObject.registerClass(
class OverviewActor extends St.BoxLayout {
    _init(sharedDash = null) {
        super._init({
            name: 'overview',
            /* Translators: This is the main view to select
                activities. See also note for "Activities" string. */
            accessible_name: _('Overview'),
            orientation: Clutter.Orientation.VERTICAL,
            // Soften the pure-black stage edges — a very dark gray reduces
            // the harsh contrast around workspace previews.
            style: 'background-color: rgba(18,20,25,0.88);',
        });

        this.add_constraint(new LayoutManager.MonitorConstraint({primary: true}));

        this._controls = new OverviewControls.ControlsManager(sharedDash);
        this.add_child(this._controls);
    }

    prepareToEnterOverview() {
        this._controls.prepareToEnterOverview();
    }

    prepareToLeaveOverview() {
        this._controls.prepareToLeaveOverview();
    }

    animateToOverview(state, callback) {
        this._controls.animateToOverview(state, callback);
    }

    animateFromOverview(callback) {
        this._controls.animateFromOverview(callback);
    }

    async runStartupAnimation() {
        await this._controls.runStartupAnimation();
    }

    get dash() {
        return this._controls.dash;
    }

    get searchController() {
        return this._controls.searchController;
    }

    get searchEntry() {
        return this._controls.searchEntry;
    }

    get controls() {
        return this._controls;
    }
});

const OverviewShownState = {
    HIDDEN: 'HIDDEN',
    HIDING: 'HIDING',
    SHOWING: 'SHOWING',
    SHOWN: 'SHOWN',
};

const OVERVIEW_SHOWN_TRANSITIONS = {
    [OverviewShownState.HIDDEN]: {
        signal: 'hidden',
        allowedTransitions: [OverviewShownState.SHOWING],
    },
    [OverviewShownState.HIDING]: {
        signal: 'hiding',
        allowedTransitions:
            [OverviewShownState.HIDDEN, OverviewShownState.SHOWING],
    },
    [OverviewShownState.SHOWING]: {
        signal: 'showing',
        allowedTransitions:
            [OverviewShownState.SHOWN, OverviewShownState.HIDING],
    },
    [OverviewShownState.SHOWN]: {
        signal: 'shown',
        allowedTransitions: [OverviewShownState.HIDING],
    },
};

export class Overview extends Signals.EventEmitter {
    constructor() {
        super();

        this._initCalled = false;
        this._visible = false;
        this._persistentDash = null;
        this._persistentDashContainer = null;
        this._persistentDashShown = false;
        this._persistentDashIdleId = 0;
        this._trackedPersistentDashWindows = new Set();

        Main.sessionMode.connect('updated', this._sessionUpdated.bind(this));
        this._sessionUpdated();
    }

    get dash() {
        return this._overview.dash;
    }

    get dashIconSize() {
        logError(new Error('Usage of Overview.\'dashIconSize\' is deprecated, ' +
            'use \'dash.iconSize\' property instead'));
        return this.dash.iconSize;
    }

    get animationInProgress() {
        return this._animationInProgress;
    }

    get visible() {
        return this._visible;
    }

    get visibleTarget() {
        return this._visibleTarget;
    }

    get closing() {
        return this._animationInProgress && !this._visibleTarget;
    }

    _createOverview() {
        if (this._overview)
            return;

        if (this.isDummy)
            return;

        this._activationTime = 0;

        this._visible = false;          // animating to overview, in overview, animating out
        this._shown = false;            // show() and not hide()
        this._modal = false;            // have a modal grab
        this._animationInProgress = false;
        this._visibleTarget = false;
        this._shownState = OverviewShownState.HIDDEN;

        // During transitions, we raise this to the top to avoid having the overview
        // area be reactive; it causes too many issues such as double clicks on
        // Dash elements, or mouseover handlers in the workspaces.
        this._coverPane = new Clutter.Actor({
            opacity: 0,
            reactive: true,
        });
        Main.layoutManager.overviewGroup.add_child(this._coverPane);
        this._coverPane.connect('event', (_actor, event) => {
            return event.type() === Clutter.EventType.ENTER ||
                event.type() === Clutter.EventType.LEAVE
                ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
        });
        this._coverPane.hide();

        // XDND
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };


        Main.layoutManager.overviewGroup.connect('scroll-event',
            this._onScrollEvent.bind(this));
        Main.xdndHandler.connect('drag-begin', this._onDragBegin.bind(this));
        Main.xdndHandler.connect('drag-end', this._onDragEnd.bind(this));

        global.display.connect('restacked', this._onRestacked.bind(this));

        this._windowSwitchTimeoutId = 0;
        this._windowSwitchTimestamp = 0;
        this._lastActiveWorkspaceIndex = -1;
        this._lastHoveredWindow = null;

        if (this._initCalled)
            this.init();
    }

    _sessionUpdated() {
        const {hasOverview} = Main.sessionMode;
        if (!hasOverview) {
            this.hide();
            this._destroyPersistentDash();
        }

        this.isDummy = !hasOverview;
        this._createOverview();

        if (hasOverview && this._initCalled)
            this._createPersistentDash();
    }

    // The members we construct that are implemented in JS might
    // want to access the overview as Main.overview to connect
    // signal handlers and so forth. So we create them after
    // construction in this init() method.
    init() {
        this._initCalled = true;

        if (this.isDummy)
            return;

        this._createPersistentDash();

        this._overview = new OverviewActor(this._persistentDash);
        this._overview._delegate = this;
        Main.layoutManager.overviewGroup.add_child(this._overview);

        Main.layoutManager.connect('monitors-changed', this._relayout.bind(this));
        this._relayout();

        Main.wm.addKeybinding(
            'toggle-overview',
            new Gio.Settings({schema_id: WindowManager.SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this.toggle.bind(this));

        const swipeTracker = new SwipeTracker.SwipeTracker(global.stage,
            Clutter.Orientation.VERTICAL,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            {allowDrag: false, allowScroll: false});
        swipeTracker.orientation = Clutter.Orientation.VERTICAL;
        swipeTracker.connect('begin', this._gestureBegin.bind(this));
        swipeTracker.connect('update', this._gestureUpdate.bind(this));
        swipeTracker.connect('end', this._gestureEnd.bind(this));
        this._swipeTracker = swipeTracker;
    }

    _createPersistentDash() {
        if (this._persistentDashContainer || this.isDummy)
            return;

        // Reuse the existing dash kept alive across session transitions,
        // or create a new one on first call
        if (!this._persistentDash)
            this._persistentDash = new Dash.Dash();
        this._persistentDashContainer = new St.Widget({
            name: 'persistentDashContainer',
            reactive: false,
            layout_manager: new Clutter.BinLayout(),
        });
        this._persistentDashContainer.add_constraint(
            new LayoutManager.MonitorConstraint({primary: true}));

        this._persistentDash.x_align = Clutter.ActorAlign.CENTER;
        this._persistentDash.y_align = Clutter.ActorAlign.END;
        this._persistentDash.y_expand = true;
        this._persistentDash.margin_bottom = PERSISTENT_DASH_BOTTOM_MARGIN;
        this._persistentDashContainer.opacity = 0;
        this._persistentDashContainer.translation_y = 12;
        this._persistentDashContainer.hide();

        this._persistentDashContainer.add_child(this._persistentDash);

        Main.layoutManager.addChrome(this._persistentDashContainer, {
            trackFullscreen: true,
        });

        global.display.connectObject(
            'restacked',
            () => this._updatePersistentDashVisibility(),
            this._persistentDashContainer);
        global.display.connectObject(
            'window-created',
            (_display, metaWindow) => this._trackWindowForPersistentDash(metaWindow),
            this._persistentDashContainer);
        global.display.connectObject(
            'notify::focus-window',
            () => this._updatePersistentDashVisibility(),
            this._persistentDashContainer);
        global.workspace_manager.connectObject(
            'active-workspace-changed',
            () => this._updatePersistentDashVisibility(),
            this._persistentDashContainer);
        Main.layoutManager.connectObject(
            'monitors-changed',
            () => {
                this._updatePersistentDashLayout();
                this._updatePersistentDashVisibility();
            },
            this._persistentDashContainer);

        this._persistentDashContainer.connectObject(
            'notify::allocation',
            () => this._updatePersistentDashVisibility(),
            this._persistentDashContainer);

        // Invalidate cached dash rect when dash content changes (favorites added/removed)
        this._persistentDash.connectObject(
            'notify::height',
            () => { this._cachedDashRect = null; },
            this._persistentDashContainer);

        for (const actor of global.get_window_actors()) {
            const metaWindow = actor.get_meta_window();
            this._trackWindowForPersistentDash(metaWindow);
        }

        this._updatePersistentDashLayout();
        this._updatePersistentDashVisibility(false);
    }

    _trackWindowForPersistentDash(metaWindow) {
        if (!metaWindow || !this._persistentDashContainer)
            return;
        if (this._trackedPersistentDashWindows.has(metaWindow))
            return;

        this._trackedPersistentDashWindows.add(metaWindow);

        const handler = () => this._updatePersistentDashVisibility();
        metaWindow.connectObject(
            'position-changed', handler,
            'size-changed', handler,
            'workspace-changed', handler,
            'notify::minimized', handler,
            'unmanaged', () => this._trackedPersistentDashWindows.delete(metaWindow),
            this._persistentDashContainer);
    }

    _destroyPersistentDash() {
        if (!this._persistentDashContainer)
            return;

        // Remove the dash from the container BEFORE destroying it.
        // The dash is shared with ControlsManager — destroying it here
        // would leave ControlsManager with a disposed reference, causing
        // "impossible to access" errors after suspend/resume cycles.
        if (this._persistentDashIdleId) {
            GLib.source_remove(this._persistentDashIdleId);
            this._persistentDashIdleId = 0;
        }

        if (this._persistentDash?.get_parent() === this._persistentDashContainer)
            this._persistentDashContainer.remove_child(this._persistentDash);

        Main.layoutManager.removeChrome(this._persistentDashContainer);
        this._persistentDashContainer.destroy();

        // Keep _persistentDash alive — ControlsManager still references it
        this._persistentDashContainer = null;
        this._persistentDashShown = false;
        this._persistentDashVisibilityQueued = false;
        this._cachedDashRect = null;
        this._trackedPersistentDashWindows.clear();
    }

    _updatePersistentDashLayout() {
        if (!this._persistentDash || !this._persistentDashContainer?.get_stage())
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const maxDashHeight =
            Math.round(monitor.height * PERSISTENT_DASH_MAX_HEIGHT_RATIO);
        this._persistentDash.setMaxSize(monitor.width, maxDashHeight);
    }

    _rectsOverlap(rectA, rectB) {
        const xOverlap = rectA.x < rectB.x + rectB.width &&
            rectA.x + rectA.width > rectB.x;
        const yOverlap = rectA.y < rectB.y + rectB.height &&
            rectA.y + rectA.height > rectB.y;

        return xOverlap && yOverlap;
    }

    _windowOverlapsPersistentDash() {
        if (!this._persistentDash)
            return false;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        // Reuse cached dashRect when monitor hasn't changed
        if (!this._cachedDashRect ||
            this._cachedDashMonitorIndex !== monitor.index) {
            this._cachedDashMonitorIndex = monitor.index;
            this._cachedDashRect = null; // will be set below
        }

        let dashRect = this._cachedDashRect;
        if (!dashRect) {
            let [, preferredDashHeight] =
                this._persistentDash.get_preferred_height(monitor.width);
            const maxDashHeight =
                Math.round(monitor.height * PERSISTENT_DASH_MAX_HEIGHT_RATIO);
            preferredDashHeight = Math.min(preferredDashHeight, maxDashHeight);

            const dashHeight = Math.max(
                1,
                preferredDashHeight + PERSISTENT_DASH_BOTTOM_MARGIN);
            dashRect = {
                x: monitor.x,
                y: monitor.y + monitor.height - dashHeight,
                width: monitor.width,
                height: dashHeight,
            };
            this._cachedDashRect = dashRect;
        }

        const activeWorkspace = global.workspace_manager.get_active_workspace();

        const windowActors = global.get_window_actors();
        for (const actor of windowActors) {
            const metaWindow = actor.get_meta_window();
            if (!metaWindow || metaWindow.minimized || metaWindow.skip_taskbar)
                continue;
            if (metaWindow.get_workspace() !== activeWorkspace)
                continue;
            if (metaWindow.get_monitor() !== monitor.index)
                continue;
            if (metaWindow.window_type !== Meta.WindowType.NORMAL &&
                metaWindow.window_type !== Meta.WindowType.DIALOG)
                continue;

            if (metaWindow.is_fullscreen() ||
                metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH)
                return true;

            const frameRect = metaWindow.get_frame_rect();
            if (this._rectsOverlap(frameRect, dashRect))
                return true;
        }

        return false;
    }

    _showPersistentDash(animate = true) {
        if (!this._persistentDashContainer)
            return;

        if (this._persistentDashShown)
            return;

        this._persistentDashShown = true;
        this._persistentDashContainer.show();
        this._persistentDashContainer.remove_all_transitions();
        this._persistentDashContainer.ease({
            opacity: 255,
            translation_y: 0,
            duration: animate ? PERSISTENT_DASH_ANIMATION_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hidePersistentDash(animate = true) {
        if (!this._persistentDashContainer)
            return;

        if (!this._persistentDashShown && !this._persistentDashContainer.visible)
            return;

        this._persistentDashShown = false;
        this._persistentDashContainer.remove_all_transitions();
        this._persistentDashContainer.ease({
            opacity: 0,
            translation_y: 12,
            duration: animate ? PERSISTENT_DASH_ANIMATION_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (!this._persistentDashShown)
                    this._persistentDashContainer.hide();
            },
        });
    }

    _updatePersistentDashVisibility(animate = true) {
        if (!this._persistentDashContainer)
            return;

        // Debounce rapid-fire signal updates into a single idle callback
        if (animate && !this._persistentDashVisibilityQueued) {
            this._persistentDashVisibilityQueued = true;
            this._persistentDashIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._persistentDashIdleId = 0;
                this._persistentDashVisibilityQueued = false;
                this._applyPersistentDashVisibility(true);
                return GLib.SOURCE_REMOVE;
            });
            return;
        } else if (!animate) {
            this._applyPersistentDashVisibility(false);
        }
    }

    _applyPersistentDashVisibility(animate = true) {
        if (!this._persistentDashContainer || !this._persistentDashContainer.get_stage())
            return;

        if (this._visible || this._animationInProgress) {
            this._showPersistentDash(false);
            return;
        }

        this._updatePersistentDashLayout();

        if (this._windowOverlapsPersistentDash())
            this._hidePersistentDash(animate);
        else
            this._showPersistentDash(animate);
    }

    _changeShownState(state) {
        const {allowedTransitions} =
            OVERVIEW_SHOWN_TRANSITIONS[this._shownState];

        if (!allowedTransitions.includes(state)) {
            throw new Error('Invalid overview shown transition from ' +
                `${this._shownState} to ${state}`);
        }

        if (this._shownState === OverviewShownState.HIDDEN)
            global.compositor.disable_unredirect();
        else if (state === OverviewShownState.HIDDEN)
            global.compositor.enable_unredirect();

        this._shownState = state;
        this.emit(OVERVIEW_SHOWN_TRANSITIONS[state].signal);
    }

    _onDragBegin() {
        this._inXdndDrag = true;

        DND.addDragMonitor(this._dragMonitor);
        // Remember the workspace we started from
        let workspaceManager = global.workspace_manager;
        this._lastActiveWorkspaceIndex = workspaceManager.get_active_workspace_index();
    }

    _onDragEnd() {
        this._inXdndDrag = false;

        // In case the drag was canceled while in the overview
        // we have to go back to where we started and hide
        // the overview
        if (this._shown) {
            let workspaceManager = global.workspace_manager;
            workspaceManager.get_workspace_by_index(this._lastActiveWorkspaceIndex)
                .activate(global.get_current_time());
            this.hide();
        }
        this._resetWindowSwitchTimeout();
        this._lastHoveredWindow = null;
        DND.removeDragMonitor(this._dragMonitor);
        this.endItemDrag();
    }

    _resetWindowSwitchTimeout() {
        if (this._windowSwitchTimeoutId !== 0) {
            GLib.source_remove(this._windowSwitchTimeoutId);
            this._windowSwitchTimeoutId = 0;
        }
    }

    _onDragMotion(dragEvent) {
        let targetIsWindow = dragEvent.targetActor &&
                             dragEvent.targetActor._delegate &&
                             dragEvent.targetActor._delegate.metaWindow &&
                             !(dragEvent.targetActor._delegate instanceof WorkspaceThumbnail.WindowClone);

        this._windowSwitchTimestamp = global.get_current_time();

        if (targetIsWindow &&
            dragEvent.targetActor._delegate.metaWindow === this._lastHoveredWindow)
            return DND.DragMotionResult.CONTINUE;

        this._lastHoveredWindow = null;

        this._resetWindowSwitchTimeout();

        if (targetIsWindow) {
            this._lastHoveredWindow = dragEvent.targetActor._delegate.metaWindow;
            this._windowSwitchTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                DND_WINDOW_SWITCH_TIMEOUT,
                () => {
                    this._windowSwitchTimeoutId = 0;
                    Main.activateWindow(dragEvent.targetActor._delegate.metaWindow,
                        this._windowSwitchTimestamp);
                    this.hide();
                    this._lastHoveredWindow = null;
                    return GLib.SOURCE_REMOVE;
                });
            GLib.Source.set_name_by_id(this._windowSwitchTimeoutId, '[gnome-shell] Main.activateWindow');
        }

        return DND.DragMotionResult.CONTINUE;
    }

    _onScrollEvent(actor, event) {
        this.emit('scroll-event', event);
        return Clutter.EVENT_PROPAGATE;
    }

    _relayout() {
        // To avoid updating the position and size of the workspaces
        // we just hide the overview. The positions will be updated
        // when it is next shown.
        this.hide();

        this._coverPane.set_position(0, 0);
        this._coverPane.set_size(global.screen_width, global.screen_height);

        // Monitor changed, invalidate dashRect cache
        this._cachedDashRect = null;
        this._updatePersistentDashLayout();
        this._updatePersistentDashVisibility();
    }

    _onRestacked() {
        let stack = global.get_window_actors();
        let stackIndices = {};

        for (let i = 0; i < stack.length; i++) {
            // Use the stable sequence for an integer to use as a hash key
            stackIndices[stack[i].get_meta_window().get_stable_sequence()] = i;
        }

        this.emit('windows-restacked', stackIndices);
    }

    _gestureBegin(tracker) {
        this._overview.controls.gestureBegin(tracker);
    }

    _gestureUpdate(tracker, progress) {
        if (progress === 0)
            return;

        if (!this._shown) {
            this._shown = true;
            this._visible = true;
            this._visibleTarget = true;
            this._animationInProgress = true;

            Main.layoutManager.overviewGroup.set_child_above_sibling(
                this._coverPane, null);
            this._coverPane.show();
            this._changeShownState(OverviewShownState.SHOWING);

            Main.layoutManager.showOverview();
            this._syncGrab();
        }

        this._overview.controls.gestureProgress(progress);
    }

    _gestureEnd(tracker, duration, endProgress) {
        let onComplete;
        if (endProgress === 0) {
            this._shown = false;
            this._visibleTarget = false;
            this._changeShownState(OverviewShownState.HIDING);
            Main.panel.style = `transition-duration: ${duration}ms;`;
            onComplete = () => this._hideDone();
        } else {
            onComplete = () => this._showDone();
        }

        this._overview.controls.gestureEnd(endProgress, duration, onComplete);
    }

    beginItemDrag(source) {
        this.emit('item-drag-begin', source);
        this._inItemDrag = true;
    }

    cancelledItemDrag(source) {
        this.emit('item-drag-cancelled', source);
    }

    endItemDrag(source) {
        if (!this._inItemDrag)
            return;
        this.emit('item-drag-end', source);
        this._inItemDrag = false;
    }

    beginWindowDrag(window) {
        this.emit('window-drag-begin', window);
        this._inWindowDrag = true;
    }

    cancelledWindowDrag(window) {
        this.emit('window-drag-cancelled', window);
    }

    endWindowDrag(window) {
        if (!this._inWindowDrag)
            return;
        this.emit('window-drag-end', window);
        this._inWindowDrag = false;
    }

    focusSearch() {
        // Search is disabled; just show the overview
        this.show();
    }

    // Checks if the Activities button is currently sensitive to
    // clicks. The first call to this function within the
    // OVERVIEW_ACTIVATION_TIMEOUT time of the hot corner being
    // triggered will return false. This avoids opening and closing
    // the overview if the user both triggered the hot corner and
    // clicked the Activities button.
    shouldToggleByCornerOrButton() {
        if (this._animationInProgress)
            return false;
        if (this._inItemDrag || this._inWindowDrag)
            return false;
        if (!this._activationTime ||
            GLib.get_monotonic_time() / GLib.USEC_PER_SEC - this._activationTime > OVERVIEW_ACTIVATION_TIMEOUT)
            return true;
        return false;
    }

    _syncGrab() {
        // We delay grab changes during animation so that when removing the
        // overview we don't have a problem with the release of a press/release
        // going to an application.
        if (this._animationInProgress)
            return true;

        if (this._shown) {
            let shouldBeModal = !this._inXdndDrag;
            if (shouldBeModal && !this._modal) {
                if (global.display.is_grabbed()) {
                    this.hide();
                    return false;
                }

                const grab = Main.pushModal(global.stage, {
                    actionMode: Shell.ActionMode.OVERVIEW,
                });
                if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
                    Main.popModal(grab);
                    this.hide();
                    return false;
                }

                this._grab = grab;
                this._modal = true;
            }
        } else {
            // eslint-disable-next-line no-lonely-if
            if (this._modal) {
                Main.popModal(this._grab);
                this._grab = false;
                this._modal = false;
            }
        }
        return true;
    }

    // show:
    //
    // Animates the overview visible and grabs mouse and keyboard input
    show(state = OverviewControls.ControlsState.WINDOW_PICKER) {
        if (state === OverviewControls.ControlsState.HIDDEN)
            throw new Error('Invalid state, use hide() to hide');

        if (this.isDummy)
            return;
        if (this._shown)
            return;
        this._shown = true;

        if (!this._syncGrab())
            return;

        Main.layoutManager.showOverview();
        this._animateVisible(state);
    }


    _animateVisible(state) {
        if (this._visible || this._animationInProgress)
            return;

        this._visible = true;
        this._animationInProgress = true;
        this._visibleTarget = true;
        this._activationTime = GLib.get_monotonic_time() / GLib.USEC_PER_SEC;

        Main.layoutManager.overviewGroup.set_child_above_sibling(
            this._coverPane, null);
        this._coverPane.show();

        this._overview.prepareToEnterOverview();
        this._changeShownState(OverviewShownState.SHOWING);
        this._overview.animateToOverview(state, () => this._showDone());
    }

    _showDone() {
        this._animationInProgress = false;
        this._coverPane.hide();

        if (this._shownState !== OverviewShownState.SHOWN)
            this._changeShownState(OverviewShownState.SHOWN);

        // Handle any calls to hide* while we were showing
        if (!this._shown)
            this._animateNotVisible();

        this._syncGrab();
        this._updatePersistentDashVisibility();
    }

    // hide:
    //
    // Reverses the effect of show()
    hide() {
        if (this.isDummy)
            return;

        if (!this._shown)
            return;

        let event = Clutter.get_current_event();
        if (event) {
            let type = event.type();
            const button =
                type === Clutter.EventType.BUTTON_PRESS ||
                type === Clutter.EventType.BUTTON_RELEASE;
            let ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
            if (button && ctrl)
                return;
        }

        this._shown = false;

        this._animateNotVisible();
        this._syncGrab();
    }

    _animateNotVisible() {
        if (!this._visible || this._animationInProgress)
            return;

        this._animationInProgress = true;
        this._visibleTarget = false;

        Main.layoutManager.overviewGroup.set_child_above_sibling(
            this._coverPane, null);
        this._coverPane.show();

        this._overview.prepareToLeaveOverview();
        this._changeShownState(OverviewShownState.HIDING);
        this._overview.animateFromOverview(() => this._hideDone());
    }

    _hideDone() {
        this._coverPane.hide();

        this._visible = false;
        this._animationInProgress = false;

        // Handle any calls to show* while we were hiding
        if (this._shown) {
            this._changeShownState(OverviewShownState.HIDDEN);
            this._animateVisible(OverviewControls.ControlsState.WINDOW_PICKER);
        } else {
            Main.layoutManager.hideOverview();
            this._changeShownState(OverviewShownState.HIDDEN);
        }

        Main.panel.style = null;

        this._syncGrab();
        this._updatePersistentDashVisibility();
    }

    toggle() {
        if (this.isDummy)
            return;

        if (this._visible)
            this.hide();
        else
            this.show();
    }

    showApps() {
        this.show(OverviewControls.ControlsState.APP_GRID);
    }

    selectApp(id) {
        this.showApps();
        this._overview.controls.appDisplay.selectApp(id);
    }

    async runStartupAnimation() {
        Main.panel.style = 'transition-duration: 0ms;';

        this._shown = true;
        this._visible = true;
        this._visibleTarget = true;
        Main.layoutManager.showOverview();
        // We should call this._syncGrab() here, but moved it to happen after
        // the animation because of a race in the xserver where the grab
        // fails when requested very early during startup.

        this._changeShownState(OverviewShownState.SHOWING);

        await this._overview.runStartupAnimation();

        // Overview got hidden during startup animation
        if (this._shownState !== OverviewShownState.SHOWING)
            return;

        if (!this._syncGrab()) {
            this.hide();
            return;
        }

        Main.panel.style = null;
        this._changeShownState(OverviewShownState.SHOWN);
    }

    getShowAppsButton() {
        logError(new Error('Usage of Overview.\'getShowAppsButton\' is deprecated, ' +
            'use \'dash.showAppsButton\' property instead'));

        return this.dash.showAppsButton;
    }

    get searchController() {
        return this._overview.searchController;
    }

    get searchEntry() {
        return this._overview.searchEntry;
    }
}
