import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppDisplay from './appDisplay.js';
import * as Dash from './dash.js';
import * as Layout from './layout.js';
import * as Main from './main.js';
import * as Overview from './overview.js';
import * as SearchController from './searchController.js';
import * as Util from '../misc/util.js';
import * as WindowManager from './windowManager.js';
import * as WorkspaceThumbnail from './workspaceThumbnail.js';
import * as WorkspacesView from './workspacesView.js';

export const SMALL_WORKSPACE_RATIO = 0.364;
const DASH_MAX_HEIGHT_RATIO = 0.128;
const VERTICAL_SPACING_RATIO = 0.02;
const THUMBNAILS_SPACING_ADJUSTMENT_TOP = 0.6;
const THUMBNAILS_SPACING_ADJUSTMENT_BOTTOM = 0.4;

const A11Y_SCHEMA = 'org.gnome.desktop.a11y.keyboard';

export const SIDE_CONTROLS_ANIMATION_TIME = 200;

/** @enum {number} */
export const ControlsState = {
    HIDDEN: 0,
    WINDOW_PICKER: 1,
    APP_GRID: 2,
};

const CONTROLS_STATES = Object.values(ControlsState);

const ControlsManagerLayout = GObject.registerClass(
class ControlsManagerLayout extends Clutter.LayoutManager {
    _init(searchEntry, appDisplay, workspacesDisplay, workspacesThumbnails,
        searchController, dash, stateAdjustment) {
        super._init();

        this._appDisplay = appDisplay;
        this._workspacesDisplay = workspacesDisplay;
        this._workspacesThumbnails = workspacesThumbnails;
        this._stateAdjustment = stateAdjustment;
        this._searchEntry = searchEntry;
        this._searchController = searchController;
        this._dash = dash;

        this._cachedWorkspaceBoxes = new Map();
        this._postAllocationCallbacks = [];

        stateAdjustment.connectObject('notify::value',
            () => this.layout_changed(), this);

        this._workAreaBox = new Clutter.ActorBox();
        global.display.connectObject(
            'workareas-changed', () => this._updateWorkAreaBox(),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._updateWorkAreaBox(),
            this);
        this._updateWorkAreaBox();
    }

    _updateWorkAreaBox() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const startX = workArea.x - monitor.x;
        const startY = workArea.y - monitor.y;
        this._workAreaBox.set_origin(startX, startY);
        this._workAreaBox.set_size(workArea.width, workArea.height);
    }

    _computeWorkspacesBoxForState(state, box, searchHeight, dashHeight, thumbnailsHeight, spacing) {
        const workspaceBox = box.copy();
        const [width, height] = workspaceBox.get_size();
        const {y1: startY} = this._workAreaBox;
        const {expandFraction} = this._workspacesThumbnails;

        switch (state) {
        case ControlsState.HIDDEN:
            workspaceBox.set_origin(...this._workAreaBox.get_origin());
            workspaceBox.set_size(...this._workAreaBox.get_size());
            break;
        case ControlsState.WINDOW_PICKER:
            // Workspace fills the full available height — the dash floats on
            // top at the bottom (z-ordered above the workspace display) so
            // the overview feels larger, matching the user's preference.
            workspaceBox.set_origin(0,
                startY + searchHeight + Math.round(spacing * THUMBNAILS_SPACING_ADJUSTMENT_TOP) +
                thumbnailsHeight + Math.round(spacing * THUMBNAILS_SPACING_ADJUSTMENT_BOTTOM) * expandFraction);
            workspaceBox.set_size(width,
                height -
                searchHeight - Math.round(spacing * THUMBNAILS_SPACING_ADJUSTMENT_TOP) -
                thumbnailsHeight - Math.round(spacing * THUMBNAILS_SPACING_ADJUSTMENT_BOTTOM) * expandFraction);
            break;
        case ControlsState.APP_GRID: {
            const previewHeight = Math.round(height * SMALL_WORKSPACE_RATIO);
            const monitor = Main.layoutManager.primaryMonitor;
            const aspect = monitor
                ? monitor.width / monitor.height : 16 / 9;
            const previewWidth = Math.round(
                Math.min(previewHeight * aspect, width * 0.85));
            const xOrigin = Math.round((width - previewWidth) / 2);
            workspaceBox.set_origin(xOrigin, startY + searchHeight + spacing);
            workspaceBox.set_size(previewWidth, previewHeight);
            break;
        }
        }

        return workspaceBox;
    }

    _getAppDisplayBoxForState(state, box, searchHeight, dashHeight, workspacesBox, spacing) {
        const [width, height] = box.get_size();
        const {y1: startY} = this._workAreaBox;
        const appDisplayBox = new Clutter.ActorBox();

        switch (state) {
        case ControlsState.HIDDEN:
        case ControlsState.WINDOW_PICKER:
            appDisplayBox.set_origin(0, box.y2);
            break;
        case ControlsState.APP_GRID:
            appDisplayBox.set_origin(0,
                startY + searchHeight + spacing + workspacesBox.get_height() + spacing);
            break;
        }

        appDisplayBox.set_size(width,
            height -
            searchHeight - spacing -
            workspacesBox.get_height() - spacing -
            dashHeight - spacing);

        return appDisplayBox;
    }

    _runPostAllocation() {
        if (this._postAllocationCallbacks.length === 0)
            return;

        this._postAllocationCallbacks.forEach(cb => cb());
        this._postAllocationCallbacks = [];
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        // The MonitorConstraint will allocate us a fixed size anyway
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        // The MonitorConstraint will allocate us a fixed size anyway
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const childBox = new Clutter.ActorBox();

        const startY = this._workAreaBox.y1;
        box.y1 += startY;
        const [width, height] = box.get_size();
        const spacing = Math.round(height * VERTICAL_SPACING_RATIO);
        let availableHeight = height;

        // Search entry (removed)
        let searchHeight = 0;
        if (this._searchEntry) {
            [searchHeight] = this._searchEntry.get_preferred_height(width);
            childBox.set_origin(0, startY);
            childBox.set_size(width, searchHeight);
            this._searchEntry.allocate(childBox);
            availableHeight -= searchHeight + spacing;
        }

        // Dash — guard against disposed dash (session transitions)
        let dashHeight = 0;
        const maxDashHeight = Math.round(box.get_height() * DASH_MAX_HEIGHT_RATIO);
        try {
            this._dash.setMaxSize(width, maxDashHeight);
            [, dashHeight] = this._dash.get_preferred_height(width);
            dashHeight = Math.min(dashHeight, maxDashHeight);
        } catch (_e) {
            dashHeight = 0;
        }
        if (this._dash.get_parent() === container) {
            childBox.set_origin(0, startY + height - dashHeight);
            childBox.set_size(width, dashHeight);
            this._dash.allocate(childBox);
        }

        availableHeight -= dashHeight + spacing;

        // Workspace Thumbnails
        let thumbnailsHeight = 0;
        if (this._workspacesThumbnails.visible) {
            const {expandFraction} = this._workspacesThumbnails;
            [thumbnailsHeight] =
                this._workspacesThumbnails.get_preferred_height(width);
            thumbnailsHeight = Math.min(
                thumbnailsHeight * expandFraction,
                height * this._workspacesThumbnails.maxThumbnailScale);
            childBox.set_origin(0, startY + searchHeight + Math.round(spacing * THUMBNAILS_SPACING_ADJUSTMENT_TOP));
            childBox.set_size(width, thumbnailsHeight);
            this._workspacesThumbnails.allocate(childBox);
        }

        // Workspaces
        let params = [box, searchHeight, dashHeight, thumbnailsHeight, spacing];
        const transitionParams = this._stateAdjustment.getStateTransitionParams();

        // Update cached boxes
        for (const state of CONTROLS_STATES) {
            this._cachedWorkspaceBoxes.set(
                state, this._computeWorkspacesBoxForState(state, ...params));
        }

        let workspacesBox;
        if (!transitionParams.transitioning) {
            workspacesBox = this._cachedWorkspaceBoxes.get(transitionParams.currentState);
        } else {
            const initialBox = this._cachedWorkspaceBoxes.get(transitionParams.initialState);
            const finalBox = this._cachedWorkspaceBoxes.get(transitionParams.finalState);
            workspacesBox = initialBox.interpolate(finalBox, transitionParams.progress);
        }

        this._workspacesDisplay.allocate(workspacesBox);

        // Corner masks for rounded workspace preview in APP_GRID
        if (this._cornerMasks) {
            const initR = transitionParams.initialState === ControlsState.APP_GRID ? 24 : 0;
            const finalR = transitionParams.finalState === ControlsState.APP_GRID ? 24 : 0;
            const r = Math.round(
                Util.lerp(initR, finalR, transitionParams.progress));
            if (r > 0) {
                const [wx, wy] = workspacesBox.get_origin();
                const [ww, wh] = workspacesBox.get_size();
                const corners = [
                    [wx, wy], [wx + ww - r, wy],
                    [wx, wy + wh - r], [wx + ww - r, wy + wh - r],
                ];
                for (let i = 0; i < 4; i++) {
                    childBox.set_origin(corners[i][0], corners[i][1]);
                    childBox.set_size(r, r);
                    this._cornerMasks[i].allocate(childBox);
                }
            }
        }

        // AppDisplay
        if (this._appDisplay.visible) {
            const workspaceAppGridBox =
                this._cachedWorkspaceBoxes.get(ControlsState.APP_GRID);

            params = [box, searchHeight, dashHeight, workspaceAppGridBox, spacing];
            let appDisplayBox;
            if (!transitionParams.transitioning) {
                appDisplayBox =
                    this._getAppDisplayBoxForState(transitionParams.currentState, ...params);
            } else {
                const initialBox =
                    this._getAppDisplayBoxForState(transitionParams.initialState, ...params);
                const finalBox =
                    this._getAppDisplayBoxForState(transitionParams.finalState, ...params);

                appDisplayBox = initialBox.interpolate(finalBox, transitionParams.progress);
            }

            this._appDisplay.allocate(appDisplayBox);
        }

        // Search
        childBox.set_origin(0, startY + searchHeight + spacing);
        childBox.set_size(width, availableHeight);

        this._searchController.allocate(childBox);

        this._runPostAllocation();
    }

    ensureAllocation() {
        this.layout_changed();
        return new Promise(
            resolve => this._postAllocationCallbacks.push(resolve));
    }

    getWorkspacesBoxForState(state) {
        return this._cachedWorkspaceBoxes.get(state);
    }
});

export const OverviewAdjustment = GObject.registerClass({
    Properties: {
        'gesture-in-progress': GObject.ParamSpec.boolean(
            'gesture-in-progress', null, null,
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class OverviewAdjustment extends St.Adjustment {
    _init(actor) {
        super._init({
            actor,
            value: ControlsState.WINDOW_PICKER,
            lower: ControlsState.HIDDEN,
            upper: ControlsState.APP_GRID,
        });
    }

    getStateTransitionParams() {
        const currentState = this.value;

        const transition = this.get_transition('value');
        let initialState = transition
            ? transition.get_interval().peek_initial_value()
            : currentState;
        let finalState = transition
            ? transition.get_interval().peek_final_value()
            : currentState;

        if (initialState > finalState) {
            initialState = Math.ceil(initialState);
            finalState = Math.floor(finalState);
        } else {
            initialState = Math.floor(initialState);
            finalState = Math.ceil(finalState);
        }

        const length = Math.abs(finalState - initialState);
        const progress = length > 0
            ? Math.abs((currentState - initialState) / length)
            : 1;

        return {
            transitioning: transition !== null || this.gestureInProgress,
            currentState,
            initialState,
            finalState,
            progress,
        };
    }
});

export const ControlsManager = GObject.registerClass(
class ControlsManager extends St.Widget {
    _init(sharedDash = null) {
        super._init({
            style_class: 'controls-manager',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });

        this._ignoreShowAppsButtonToggle = false;
        this._usesSharedDash = sharedDash !== null;

        // Search entry removed — no search bar, no RAM label
        this._searchEntry = null;
        this._searchEntryBin = null;

        this._lastThumbnailsOpacity = -1;
        this._lastThumbnailsScale = -1;
        this._lastThumbnailsTranslationY = -1;

        this.dash = sharedDash ?? new Dash.Dash();

        this._workspaceAdjustment = Main.createWorkspacesAdjustment(this);

        this._stateAdjustment = new OverviewAdjustment(this);
        this._stateAdjustment.connectObject('notify::value',
            () => this._update(), this);

        this._lastCornerRadius = 0;
        this._lastFitMode = -1;

        // Create a dummy search entry for SearchController compatibility
        this._dummySearchEntry = new St.Entry({visible: false});
        this._searchController = new SearchController.SearchController(
            this._dummySearchEntry,
            this.dash.showAppsButton);
        // Prevent search from ever activating
        this._searchController.visible = false;

        Main.layoutManager.connectObject('monitors-changed', () =>
            this._thumbnailsBox.setMonitorIndex(Main.layoutManager.primaryIndex), this);
        this._thumbnailsBox = new WorkspaceThumbnail.ThumbnailsBox(
            this._workspaceAdjustment, Main.layoutManager.primaryIndex);
        this._thumbnailsBox.connectObject('notify::should-show', () => {
            this._thumbnailsBox.show();
            this._thumbnailsBox.ease_property('expand-fraction',
                this._thumbnailsBox.should_show ? 1 : 0, {
                    duration: SIDE_CONTROLS_ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._updateThumbnailsBox(),
                });
        }, this);

        this._workspacesDisplay = new WorkspacesView.WorkspacesDisplay(
            this,
            this._workspaceAdjustment,
            this._stateAdjustment);
        this._appDisplay = new AppDisplay.AppDisplay();

        // Corner-mask overlay widgets: four tiny actors positioned at
        // the workspace preview corners in APP_GRID state.  Each paints
        // a quarter-circle of the overview background colour, visually
        // rounding the rectangular preview without a GPU shader.
        this._cornerMasks = [];
        const cornerBorderProps = [
            'border-top-left-radius',
            'border-top-right-radius',
            'border-bottom-left-radius',
            'border-bottom-right-radius',
        ];
        for (let i = 0; i < 4; i++) {
            const mask = new St.Widget({
                reactive: false,
                can_focus: false,
                visible: false,
            });
            mask._cornerStyleProp = cornerBorderProps[i];
            this._cornerMasks.push(mask);
        }

        // Z-order: workspace below dash so the dash floats visibly
        // on top of the full-height workspace preview.
        this.add_child(this._appDisplay);
        this.add_child(this._workspacesDisplay);
        for (const mask of this._cornerMasks)
            this.add_child(mask);
        if (this.dash.get_parent() === null)
            this.add_child(this.dash);
        this.add_child(this._searchController);
        this.add_child(this._thumbnailsBox);

        this.layout_manager = new ControlsManagerLayout(
            null,  // no search entry
            this._appDisplay,
            this._workspacesDisplay,
            this._thumbnailsBox,
            this._searchController,
            this.dash,
            this._stateAdjustment);

        this.layout_manager._cornerMasks = this._cornerMasks;

        this.dash.showAppsButton.connectObject('notify::checked',
            () => this._onShowAppsButtonToggled(), this);

        Main.ctrlAltTabManager.addGroup(
            this.appDisplay,
            _('Apps'),
            'shell-focus-app-grid-symbolic', {
                proxy: this,
                focusCallback: () => {
                    this.dash.showAppsButton.checked = true;
                    this.appDisplay.navigate_focus(
                        null, St.DirectionType.TAB_FORWARD, false);
                },
            });

        Main.ctrlAltTabManager.addGroup(
            this._workspacesDisplay,
            _('Windows'),
            'shell-focus-windows-symbolic', {
                proxy: this,
                focusCallback: () => {
                    this.dash.showAppsButton.checked = false;
                    this._workspacesDisplay.navigate_focus(
                        null, St.DirectionType.TAB_FORWARD, false);
                },
            });

        this._a11ySettings = new Gio.Settings({schema_id: A11Y_SCHEMA});

        this._lastOverlayKeyTime = 0;
        global.display.connectObject('overlay-key', () => {
            if (this._a11ySettings.get_boolean('stickykeys-enable'))
                return;

            const {initialState, finalState, transitioning} =
                this._stateAdjustment.getStateTransitionParams();

            const time = GLib.get_monotonic_time() / 1000;
            const timeDiff = time - this._lastOverlayKeyTime;
            this._lastOverlayKeyTime = time;

            const shouldShift = St.Settings.get().enable_animations
                ? transitioning && finalState > initialState
                : Main.overview.visible && timeDiff < Overview.ANIMATION_TIME;

            if (shouldShift)
                this._shiftState(Meta.MotionDirection.UP);
            else
                Main.overview.toggle();
        }, this);

        // connect_after to give search controller first dibs on the event
        this._stageKeyPressId = global.stage.connect_after('key-press-event', (actor, event) => {
            if (this._searchController.searchActive)
                return Clutter.EVENT_PROPAGATE;

            if (global.stage.key_focus &&
                !this.contains(global.stage.key_focus))
                return Clutter.EVENT_PROPAGATE;

            const {finalState} =
                this._stateAdjustment.getStateTransitionParams();
            let keynavDisplay;

            if (finalState === ControlsState.WINDOW_PICKER)
                keynavDisplay = this._workspacesDisplay;
            else if (finalState === ControlsState.APP_GRID)
                keynavDisplay = this._appDisplay;

            if (!keynavDisplay)
                return Clutter.EVENT_PROPAGATE;

            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_Down) {
                keynavDisplay.navigate_focus(
                    null, St.DirectionType.TAB_FORWARD, false);
                return Clutter.EVENT_STOP;
            } else if (symbol === Clutter.KEY_ISO_Left_Tab) {
                keynavDisplay.navigate_focus(
                    null, St.DirectionType.TAB_BACKWARD, false);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        Main.wm.addKeybinding(
            'toggle-application-view',
            new Gio.Settings({schema_id: WindowManager.SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this._toggleAppsPage.bind(this));

        Main.wm.addKeybinding('shift-overview-up',
            new Gio.Settings({schema_id: WindowManager.SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._shiftState(Meta.MotionDirection.UP));

        Main.wm.addKeybinding('shift-overview-down',
            new Gio.Settings({schema_id: WindowManager.SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._shiftState(Meta.MotionDirection.DOWN));

        this._update();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _getFitModeForState(state) {
        switch (state) {
        case ControlsState.HIDDEN:
        case ControlsState.WINDOW_PICKER:
            return WorkspacesView.FitMode.SINGLE;
        case ControlsState.APP_GRID:
            return WorkspacesView.FitMode.ALL;
        default:
            return WorkspacesView.FitMode.SINGLE;
        }
    }

    _getThumbnailsBoxParams() {
        const {initialState, finalState, progress} =
            this._stateAdjustment.getStateTransitionParams();

        const paramsForState = s => {
            let opacity, scale, translationY;
            switch (s) {
            case ControlsState.HIDDEN:
            case ControlsState.WINDOW_PICKER:
                opacity = 255;
                scale = 1;
                translationY = 0;
                break;
            case ControlsState.APP_GRID:
                opacity = 0;
                scale = 0.5;
                translationY = this._thumbnailsBox.height / 2;
                break;
            default:
                opacity = 255;
                scale = 1;
                translationY = 0;
                break;
            }

            return {opacity, scale, translationY};
        };

        const initialParams = paramsForState(initialState);
        const finalParams = paramsForState(finalState);

        return [
            Util.lerp(initialParams.opacity, finalParams.opacity, progress),
            Util.lerp(initialParams.scale, finalParams.scale, progress),
            Util.lerp(initialParams.translationY, finalParams.translationY, progress),
        ];
    }

    _updateThumbnailsBox(animate = false) {
        const {shouldShow} = this._thumbnailsBox;
        const {searchActive} = this._searchController;
        const [opacity, scale, translationY] = this._getThumbnailsBoxParams();

        const targetOpacity = searchActive ? 0 : opacity;
        const thumbnailsBoxVisible = shouldShow && !searchActive && opacity !== 0;

        // Skip redundant ease calls during per-frame _update()
        if (!animate &&
            targetOpacity === this._lastThumbnailsOpacity &&
            scale === this._lastThumbnailsScale &&
            translationY === this._lastThumbnailsTranslationY) {
            return;
        }
        this._lastThumbnailsOpacity = targetOpacity;
        this._lastThumbnailsScale = scale;
        this._lastThumbnailsTranslationY = translationY;

        if (thumbnailsBoxVisible) {
            this._thumbnailsBox.opacity = 0;
            this._thumbnailsBox.visible = thumbnailsBoxVisible;
            this._thumbnailsBox.expandFraction = 1.0;
        }

        // Per-frame calls (duration 0): set properties directly instead of
        // creating/completing throwaway Clutter transition objects.
        if (!animate) {
            this._thumbnailsBox.opacity = targetOpacity;
            if (!searchActive) {
                this._thumbnailsBox.scale_x = scale;
                this._thumbnailsBox.scale_y = scale;
                this._thumbnailsBox.translation_y = translationY;
            }
            this._thumbnailsBox.visible = thumbnailsBoxVisible;
            if (!thumbnailsBoxVisible)
                this._thumbnailsBox.expandFraction = 0.0;
            return;
        }

        const params = {
            opacity: targetOpacity,
            duration: SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this._thumbnailsBox.visible = thumbnailsBoxVisible;
                if (!thumbnailsBoxVisible)
                    this._thumbnailsBox.expandFraction = 0.0;
            },
        };

        if (!searchActive) {
            params.scale_x = scale;
            params.scale_y = scale;
            params.translation_y = translationY;
        }

        this._thumbnailsBox.ease(params);
    }

    _updateAppDisplayVisibility(stateTransitionParams = null) {
        if (!stateTransitionParams)
            stateTransitionParams = this._stateAdjustment.getStateTransitionParams();

        const {initialState, finalState} = stateTransitionParams;
        const state = Math.max(initialState, finalState);

        this._appDisplay.visible =
            state > ControlsState.WINDOW_PICKER &&
            !this._searchController.searchActive;
    }

    _update() {
        const params = this._stateAdjustment.getStateTransitionParams();

        const fitMode = Util.lerp(
            this._getFitModeForState(params.initialState),
            this._getFitModeForState(params.finalState),
            params.progress);

        // Avoid redundant notify::value on every frame
        if (fitMode !== this._lastFitMode) {
            this._lastFitMode = fitMode;
            this._workspacesDisplay.fitModeAdjustment.value = fitMode;
        }

        // Rounded corners on workspace preview in APP_GRID state.
        // Corner-mask overlay widgets are used instead of CSS on
        // _workspacesDisplay because clip_to_allocation + border-radius
        // does not clip child content to a rounded rectangle in St.
        const initialRadius =
            params.initialState === ControlsState.APP_GRID ? 24 : 0;
        const finalRadius =
            params.finalState === ControlsState.APP_GRID ? 24 : 0;
        const radius = Math.round(
            Util.lerp(initialRadius, finalRadius, params.progress));
        if (radius !== this._lastCornerRadius) {
            this._lastCornerRadius = radius;
            if (radius > 0) {
                for (const mask of this._cornerMasks) {
                    mask.style =
                        `background-color: rgba(18,20,25,0.88); ` +
                        `${mask._cornerStyleProp}: ${radius}px;`;
                    mask.visible = true;
                }
            } else {
                for (const mask of this._cornerMasks) {
                    mask.visible = false;
                    mask.style = null;
                }
            }
        }

        this._updateThumbnailsBox();
        this._updateAppDisplayVisibility(params);
    }

    _onSearchChanged() {
        // Search is disabled; keep everything visible
        this._updateAppDisplayVisibility();
        this._workspacesDisplay.reactive = true;
        this._workspacesDisplay.setPrimaryWorkspaceVisible(true);
        this._updateThumbnailsBox();
        this._searchController.visible = false;
    }

    _onShowAppsButtonToggled() {
        if (this._ignoreShowAppsButtonToggle)
            return;

        let checked;
        try {
            checked = this.dash.showAppsButton.checked;
        } catch (_e) {
            return;
        }

        if (!Main.overview.visible) {
            if (checked)
                Main.overview.show(ControlsState.APP_GRID);
            return;
        }

        if (checked) {
            // In overview (WINDOW_PICKER) → transition to APP_GRID
            this._stateAdjustment.remove_transition('value');
            this._stateAdjustment.ease(ControlsState.APP_GRID, {
                duration: SIDE_CONTROLS_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            // In APP_GRID → go directly to desktop, skip WINDOW_PICKER
            Main.overview.hide();
        }
    }

    _toggleAppsPage() {
        if (Main.overview.visible) {
            const checked = this.dash.showAppsButton.checked;
            this.dash.showAppsButton.checked = !checked;
        } else {
            Main.overview.show(ControlsState.APP_GRID);
        }
    }

    _shiftState(direction) {
        let {currentState, finalState} = this._stateAdjustment.getStateTransitionParams();

        if (direction === Meta.MotionDirection.DOWN) {
            // From APP_GRID, skip WINDOW_PICKER → go straight to desktop
            if (finalState >= ControlsState.APP_GRID)
                finalState = ControlsState.HIDDEN;
            else
                finalState = Math.max(finalState - 1, ControlsState.HIDDEN);
        } else if (direction === Meta.MotionDirection.UP)
            finalState = Math.min(finalState + 1, ControlsState.APP_GRID);

        if (finalState === currentState)
            return;

        if (currentState === ControlsState.HIDDEN &&
            finalState === ControlsState.WINDOW_PICKER) {
            Main.overview.show();
        } else if (finalState === ControlsState.HIDDEN) {
            Main.overview.hide();
        } else {
            this._stateAdjustment.ease(finalState, {
                duration: SIDE_CONTROLS_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    this.dash.showAppsButton.checked =
                        finalState === ControlsState.APP_GRID;
                },
            });
        }
    }

    vfunc_unmap() {
        super.vfunc_unmap();
        this._workspacesDisplay?.hide();
    }

    _onDestroy() {
        if (this._stageKeyPressId) {
            global.stage.disconnect(this._stageKeyPressId);
            this._stageKeyPressId = 0;
        }
        delete this._appDisplay;
        if (!this._usesSharedDash)
            delete this.dash;
        delete this._searchController;
        if (this._dummySearchEntry) {
            this._dummySearchEntry.destroy();
            this._dummySearchEntry = null;
        }
        if (this._cornerMasks) {
            for (const mask of this._cornerMasks)
                mask.destroy();
            this._cornerMasks = [];
            if (this.layout_manager)
                this.layout_manager._cornerMasks = null;
        }
        delete this._thumbnailsBox;
        delete this._workspacesDisplay;
    }

    prepareToEnterOverview() {
        this._searchController.prepareToEnterOverview();
        this._workspacesDisplay.prepareToEnterOverview();
    }

    prepareToLeaveOverview() {
        this._searchController.prepareToLeaveOverview();
        this._workspacesDisplay.prepareToLeaveOverview();
    }

    animateToOverview(state, callback) {
        this._ignoreShowAppsButtonToggle = true;

        this._stateAdjustment.value = ControlsState.HIDDEN;
        this._stateAdjustment.ease(state, {
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (callback)
                    callback();
            },
        });

        try {
            this.dash.showAppsButton.checked =
                state === ControlsState.APP_GRID;
        } catch (_e) {
            // Dash may be disposed during session transitions
        }

        this._ignoreShowAppsButtonToggle = false;
    }

    animateFromOverview(callback) {
        this._ignoreShowAppsButtonToggle = true;

        this._stateAdjustment.ease(ControlsState.HIDDEN, {
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                try {
                    this.dash.showAppsButton.checked = false;
                } catch (_e) {
                    // Dash may be disposed during session transitions
                }
                this._ignoreShowAppsButtonToggle = false;

                if (callback)
                    callback();
            },
        });
    }

    getWorkspacesBoxForState(state) {
        return this.layoutManager.getWorkspacesBoxForState(state);
    }

    gestureBegin(tracker) {
        const baseDistance = global.screen_height;
        const progress = this._stateAdjustment.value;
        const points = [
            ControlsState.HIDDEN,
            ControlsState.WINDOW_PICKER,
            ControlsState.APP_GRID,
        ];

        const transition = this._stateAdjustment.get_transition('value');
        const cancelProgress = transition
            ? transition.get_interval().peek_final_value()
            : Math.round(progress);
        this._stateAdjustment.remove_transition('value');

        tracker.confirmSwipe(baseDistance, points, progress, cancelProgress);
        this.prepareToEnterOverview();
        this._stateAdjustment.gestureInProgress = true;
    }

    gestureProgress(progress) {
        this._stateAdjustment.value = progress;
    }

    gestureEnd(target, duration, onComplete) {
        if (target === ControlsState.HIDDEN)
            this.prepareToLeaveOverview();

        this._ignoreShowAppsButtonToggle = true;
        this.dash.showAppsButton.checked =
            target === ControlsState.APP_GRID;
        this._ignoreShowAppsButtonToggle = false;

        this._stateAdjustment.remove_transition('value');
        this._stateAdjustment.ease(target, {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: onComplete,
        });

        this._stateAdjustment.gestureInProgress = false;
    }

    async runStartupAnimation() {
        this._ignoreShowAppsButtonToggle = true;

        this.prepareToEnterOverview();

        this._stateAdjustment.value = ControlsState.HIDDEN;
        this._stateAdjustment.ease(ControlsState.WINDOW_PICKER, {
            duration: Overview.ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this.dash.showAppsButton.checked = false;
        this._ignoreShowAppsButtonToggle = false;

        // Set the opacity here to avoid a 1-frame flicker
        this.opacity = 0;

        // We can't run the animation before the first allocation happens
        await this.layout_manager.ensureAllocation();

        const {STARTUP_ANIMATION_TIME} = Layout;

        // Opacity
        this.ease({
            opacity: 255,
            duration: STARTUP_ANIMATION_TIME,
            mode: Clutter.AnimationMode.LINEAR,
        });

        // The Dash rises from the bottom. This is the last animation to finish,
        // so resolve the promise there.
        if (this.dash.get_parent() === this) {
            this.dash.translation_y = this.dash.height + this.dash.margin_bottom;
            return new Promise(resolve => {
                this.dash.ease({
                    translation_y: 0,
                    delay: STARTUP_ANIMATION_TIME,
                    duration: STARTUP_ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => resolve(),
                });
            });
        }

        return Promise.resolve();
    }

    get searchController() {
        return this._searchController;
    }

    get searchEntry() {
        return this._searchEntry;
    }

    get appDisplay() {
        return this._appDisplay;
    }
});
