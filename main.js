const {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  Notice,
  Keymap,
  moment,
} = require("obsidian");

const CLOCK_CLASS = "forest-clock";
const POPUP_CLASS = "forest-clock-popup";

const DEFAULT_SETTINGS = {
  use24Hour: false,
  firstDayOfWeek: 0, // 0 = Sunday, 1 = Monday
  timezone: "", // "" = system / local (auto)
  logTarget: "daily", // "daily" | "active"
  accentMode: "theme", // "theme" | "color" | "gradient"
  accentColor: "#7f6df2",
  gradientPreset: "forest",
  gradientA: "#38ef7d",
  gradientB: "#11998e",
  headerDisplay: "clock", // while a timer runs: "clock" (+dot) | "timer" | "both"
  colorHeaderTimer: false,
  boldClock: false,
};

const GRADIENT_PRESETS = {
  forest: ["#38ef7d", "#11998e"],
  sunset: ["#ff9a5a", "#ff4d6d"],
  ocean: ["#4facfe", "#00f2fe"],
  candy: ["#f093fb", "#f5576c"],
  ember: ["#ff9966", "#ff5e62"],
  mono: ["#c9c9c9", "#7a7a7a"],
};

// Fallback if Intl.supportedValuesOf is unavailable
const FALLBACK_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];

const MAX_HISTORY = 4;
const DEFAULT_COUNTDOWN = 25 * 60 * 1000;
const MAX_COUNTDOWN = 24 * 60 * 60 * 1000;

module.exports = class ForestClock extends Plugin {
  async onload() {
    // State
    this._unloaded = false;
    this.clockEl = null;
    this.popupEl = null;
    this.popupOpen = false;

    // Header render state: structure rebuilt only when shape changes, text
    // spans updated in place so the run-dot animation never restarts
    this.hdrShape = "";
    this.hdrClockSpan = null;
    this.hdrTimerSpan = null;

    // Stopwatch state (timestamp-based, no drift)
    this.sw = {
      running: false,
      startTime: 0, // ms epoch when current run segment started
      accumulated: 0, // ms accumulated from prior stop/start segments
      displayEl: null,
      tickInterval: null, // ~100ms smooth update
    };

    // Countdown / pomodoro state (also timestamp-based)
    this.cd = {
      running: false,
      endTime: 0, // ms epoch when the countdown hits zero
      remaining: DEFAULT_COUNTDOWN, // authoritative while paused
      setMs: DEFAULT_COUNTDOWN, // last configured duration (what Reset returns to)
    };
    this.cdEditing = false;

    // Which display the timer section shows; persisted
    this.timerMode = "stopwatch"; // "stopwatch" | "countdown"

    // Session label (runtime only; defaults to the active note until edited)
    this.sessionLabel = "";
    this.labelDirty = false;

    // Run history (most recent first), persisted. Each: { ms, ended, label }
    this.history = [];
    this.historyEl = null;

    // Popup element refs (null while closed)
    this.timerBodyEl = null;
    this.secTitleEl = null;
    this.modeBtnEl = null;
    this.cdBtnEl = null;
    this.labelInputEl = null;

    // Settings (overwritten by loadAll)
    this.settings = Object.assign({}, DEFAULT_SETTINGS);

    // Restore persisted settings + stopwatch + countdown + history before anything reads them
    await this.loadAll();

    // Calendar view month
    const np = this.nowParts();
    this.calYear = np.y;
    this.calMonth = np.m; // 0-11
    this.calGridEl = null;
    this.calLabelEl = null;
    this.calDowEl = null;

    // Bound handlers we attach/detach manually
    this.onOutsideClick = (evt) => {
      if (!this.popupOpen) return;
      const target = evt.target;
      if (this.popupEl && this.popupEl.contains(target)) return;
      if (this.clockEl && this.clockEl.contains(target)) return;
      this.closePopup();
    };
    this.onKeyDown = (evt) => {
      if (this.popupOpen && evt.key === "Escape") {
        // While the countdown duration editor is open, Escape cancels the
        // edit (its own handler); it shouldn't also close the popup
        if (this.cdEditing) return;
        this.closePopup();
      }
    };

    this.addSettingTab(new ClockSettingTab(this.app, this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => {
      // Bail if the plugin was unloaded before layout became ready
      if (this._unloaded) return;

      this.ensureClock();

      // One interval, 1s. Also drives countdown completion + the header timer
      this.registerInterval(
        window.setInterval(() => {
          this.updateClock();
        }, 1000)
      );

      // Re-injection on layout/leaf changes. Close any open popup so it never floats detached from a clock that just moved or got hidden
      this.registerEvent(
        this.app.workspace.on("layout-change", () => {
          this.ensureClock();
          if (this.popupOpen) this.closePopup();
        })
      );
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () => {
          this.ensureClock();
          if (this.popupOpen) this.closePopup();
        })
      );
    });
  }

  onunload() {
    // Mark unloaded first so a still-pending onLayoutReady callback bails out instead of registering an interval/events on a dead Component
    this._unloaded = true;
    // Popup + its manual listeners. closePopup() owns stopwatch tickInterval
    this.closePopup();
    // Clock element
    if (this.clockEl) {
      this.clockEl.remove();
      this.clockEl = null;
    }
    // Safety sweep
    document
      .querySelectorAll("." + CLOCK_CLASS + ", ." + POPUP_CLASS)
      .forEach((el) => el.remove());
  }

  // Persistence

  async loadAll() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    const s = data.stopwatch || {};
    this.sw.running = !!s.running;
    this.sw.startTime = s.startTime || 0;
    this.sw.accumulated = s.accumulated || 0;
    const c = data.countdown || {};
    this.cd.running = !!c.running;
    this.cd.endTime = c.endTime || 0;
    this.cd.remaining =
      typeof c.remaining === "number" ? c.remaining : DEFAULT_COUNTDOWN;
    this.cd.setMs = c.setMs || DEFAULT_COUNTDOWN;
    // A countdown that expired while Obsidian was closed lands finished, no Notice
    if (this.cd.running && this.cd.endTime <= Date.now()) {
      this.cd.running = false;
      this.cd.endTime = 0;
      this.cd.remaining = 0;
    }
    this.timerMode = data.timerMode === "countdown" ? "countdown" : "stopwatch";
    this.history = Array.isArray(data.history)
      ? data.history.slice(0, MAX_HISTORY)
      : [];
  }

  persist() {
    // Fire-and-forget; callers don't need to await disk writes
    this.saveData({
      settings: this.settings,
      stopwatch: {
        running: this.sw.running,
        startTime: this.sw.startTime,
        accumulated: this.sw.accumulated,
      },
      countdown: {
        running: this.cd.running,
        endTime: this.cd.endTime,
        remaining: this.cd.remaining,
        setMs: this.cd.setMs,
      },
      timerMode: this.timerMode,
      history: this.history,
    });
  }

  // Commands (hotkey)

  registerCommands() {
    this.addCommand({
      id: "toggle-popup",
      name: "Toggle clock popup",
      callback: () => this.togglePopup(),
    });
    this.addCommand({
      id: "toggle-stopwatch",
      name: "Start/stop stopwatch",
      callback: () => (this.sw.running ? this.swStop() : this.swStart()),
    });
    this.addCommand({
      id: "reset-stopwatch",
      name: "Reset stopwatch",
      callback: () => this.swReset(),
    });
    this.addCommand({
      id: "log-session",
      name: "Add stopwatch session to note",
      callback: () => this.logSession(),
    });
    this.addCommand({
      id: "insert-timestamp",
      name: "Insert timestamp at cursor",
      editorCallback: (editor) => {
        editor.replaceSelection(this.formatClock(new Date()));
      },
    });
    this.addCommand({
      id: "open-today",
      name: "Open today's daily note",
      callback: () => this.openDailyNote(this.nowDate()),
    });
  }

  // Clock injection

  getHeaderContainer() {
    return (
      document.querySelector(
        ".workspace-split.mod-left-split .workspace-tabs.mod-top .workspace-tab-header-container"
      ) ||
      document.querySelector(
        ".workspace-split.mod-left-split .workspace-tab-header-container"
      )
    );
  }

  ensureClock() {
    const container = this.getHeaderContainer();
    if (!container) return; // skip this tick, retry on next layout-change/interval

    // If clock exists but is detached or in the wrong container move it
    if (this.clockEl && this.clockEl.isConnected) {
      if (this.clockEl.parentElement !== container) {
        container.appendChild(this.clockEl);
      }
    } else {
      // Adopt/dedupe across document, not just this container. On full workspace layout rebuild the old header container can be replaced while clock stays attached elsewhere
      const all = document.querySelectorAll("." + CLOCK_CLASS);
      let existing = null;
      all.forEach((el, i) => {
        if (i === 0) existing = el;
        else el.remove(); // kill any duplicates
      });
      if (!existing) {
        existing = document.createElement("div");
        existing.className = CLOCK_CLASS;
        existing.setAttribute("aria-label", "Clock — stopwatch & calendar");
        this.registerDomEvent(existing, "click", (evt) => {
          evt.stopPropagation();
          this.togglePopup();
        });
      }
      if (existing.parentElement !== container) {
        container.appendChild(existing);
      }
      this.clockEl = existing;
      this.hdrShape = ""; // force a structure rebuild on next update
      this.applyAccent();
    }
    this.updateClock();
  }

  // Accent / gradient

  gradientStops() {
    const s = this.settings;
    if (s.gradientPreset === "custom") return [s.gradientA, s.gradientB];
    return GRADIENT_PRESETS[s.gradientPreset] || GRADIENT_PRESETS.forest;
  }

  applyAccent() {
    const s = this.settings;
    [this.clockEl, this.popupEl].forEach((el) => {
      if (!el) return;
      el.removeClass("wclock-color");
      el.removeClass("wclock-grad");
      el.style.removeProperty("--wclock-accent");
      el.style.removeProperty("--wclock-g1");
      el.style.removeProperty("--wclock-g2");
      if (s.accentMode === "color") {
        el.addClass("wclock-color");
        el.style.setProperty("--wclock-accent", s.accentColor);
      } else if (s.accentMode === "gradient") {
        const stops = this.gradientStops();
        el.addClass("wclock-grad");
        el.style.setProperty("--wclock-g1", stops[0]);
        el.style.setProperty("--wclock-g2", stops[1]);
        // Solid fallback for pieces that can't take a gradient
        el.style.setProperty("--wclock-accent", stops[0]);
      }
      el.toggleClass("wclock-hdr-colored", !!s.colorHeaderTimer);
    });
    // Header-only: bolds the time of day, never the running timer beside it
    if (this.clockEl) this.clockEl.toggleClass("wclock-bold", !!s.boldClock);
  }

  // Time helpers

  formatClock(d) {
    const opts = {
      hour: this.settings.use24Hour ? "2-digit" : "numeric",
      minute: "2-digit",
      hourCycle: this.settings.use24Hour ? "h23" : "h12",
    };
    if (this.settings.timezone) opts.timeZone = this.settings.timezone;
    try {
      return new Intl.DateTimeFormat("en-US", opts).format(d);
    } catch (e) {
      // Bad/unsupported timezone — fall back to local.
      delete opts.timeZone;
      return new Intl.DateTimeFormat("en-US", opts).format(d);
    }
  }

  // Returns { y, m (0-11), day } for "now" in the configured timezone (or local).
  nowParts() {
    const d = new Date();
    const tz = this.settings.timezone;
    if (!tz) {
      return { y: d.getFullYear(), m: d.getMonth(), day: d.getDate() };
    }
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(d);
      const map = {};
      parts.forEach((p) => (map[p.type] = p.value));
      return { y: +map.year, m: +map.month - 1, day: +map.day };
    } catch (e) {
      return { y: d.getFullYear(), m: d.getMonth(), day: d.getDate() };
    }
  }

  nowDate() {
    const p = this.nowParts();
    return new Date(p.y, p.m, p.day);
  }

  // Header rendering. Structure (clock / timer / both / dot) rebuilds only when
  // the shape changes; per-second updates just rewrite the text spans

  headerTimerText() {
    if (this.cd.running) return this.formatStopwatch(this.cdRemaining());
    return this.formatStopwatch(this.swElapsed());
  }

  refreshHeader() {
    this.hdrShape = "";
    this.updateClock();
  }

  updateClock() {
    this.checkCountdown();
    if (!this.clockEl) return;
    const running = this.sw.running || this.cd.running;
    const mode = this.settings.headerDisplay;
    const shape = mode + "|" + running;
    if (shape !== this.hdrShape) {
      this.hdrShape = shape;
      this.clockEl.empty();
      this.hdrClockSpan = null;
      this.hdrTimerSpan = null;
      if (running && mode === "timer") {
        this.hdrTimerSpan = this.clockEl.createSpan({
          cls: "forest-clock-timer",
        });
      } else if (running && mode === "both") {
        this.hdrClockSpan = this.clockEl.createSpan({ cls: "forest-clock-time" });
        this.clockEl.createSpan({ cls: "forest-clock-sep", text: "|" });
        this.hdrTimerSpan = this.clockEl.createSpan({
          cls: "forest-clock-timer",
        });
      } else {
        this.hdrClockSpan = this.clockEl.createSpan({ cls: "forest-clock-time" });
        if (running) this.clockEl.createSpan({ cls: "forest-clock-dot" });
      }
    }
    if (this.hdrClockSpan) {
      const t = this.formatClock(new Date());
      if (this.hdrClockSpan.textContent !== t) {
        this.hdrClockSpan.textContent = t;
      }
    }
    if (this.hdrTimerSpan) {
      const t = this.headerTimerText();
      if (this.hdrTimerSpan.textContent !== t) {
        this.hdrTimerSpan.textContent = t;
      }
    }
  }

  // Popup

  togglePopup() {
    if (this.popupOpen) this.closePopup();
    else this.openPopup();
  }

  openPopup() {
    if (this.popupOpen || !this.clockEl) return;

    const popup = document.createElement("div");
    popup.className = POPUP_CLASS;

    // Timestamp bar
    const tsBar = popup.createEl("button", {
      cls: "forest-ts-bar",
      text: "Add timestamp to note",
    });
    this.registerDomEvent(tsBar, "click", () => this.insertTimestamp());

    popup.createDiv({ cls: "forest-divider" });

    // Timer section: one area, stopwatch or countdown, switched top-right
    const swSection = popup.createDiv({ cls: "forest-sw" });
    const secHead = swSection.createDiv({ cls: "forest-sec-head" });
    this.secTitleEl = secHead.createSpan({ cls: "forest-sec-title" });
    this.modeBtnEl = secHead.createEl("button", {
      cls: "forest-mode-switch",
    });
    this.modeBtnEl.setAttribute("aria-label", "Switch timer display");
    this.registerDomEvent(this.modeBtnEl, "click", () => {
      this.timerMode =
        this.timerMode === "stopwatch" ? "countdown" : "stopwatch";
      this.persist();
      this.renderTimerSection();
    });
    this.timerBodyEl = swSection.createDiv({ cls: "forest-sw-body" });

    // Calendar section
    const calSection = popup.createDiv({ cls: "forest-cal" });
    const calHeader = calSection.createDiv({ cls: "forest-cal-header" });
    const prevBtn = calHeader.createEl("button", {
      text: "‹",
      cls: "forest-cal-nav",
    });
    const label = calHeader.createDiv({ cls: "forest-cal-label" });
    const nextBtn = calHeader.createEl("button", {
      text: "›",
      cls: "forest-cal-nav",
    });
    label.setAttribute("title", "Jump to current month");
    this.registerDomEvent(label, "click", () => {
      const np = this.nowParts();
      this.calYear = np.y;
      this.calMonth = np.m;
      this.renderCalendar();
    });
    this.calLabelEl = label;

    const dow = calSection.createDiv({ cls: "forest-cal-grid forest-cal-dow" });
    this.calDowEl = dow;

    const grid = calSection.createDiv({ cls: "forest-cal-grid forest-cal-days" });
    this.calGridEl = grid;

    this.registerDomEvent(prevBtn, "click", () => {
      this.calMonth--;
      if (this.calMonth < 0) {
        this.calMonth = 11;
        this.calYear--;
      }
      this.renderCalendar();
    });
    this.registerDomEvent(nextBtn, "click", () => {
      this.calMonth++;
      if (this.calMonth > 11) {
        this.calMonth = 0;
        this.calYear++;
      }
      this.renderCalendar();
    });

    document.body.appendChild(popup);
    this.popupEl = popup;
    this.popupOpen = true;

    this.applyAccent();
    this.positionPopup();
    this.renderTimerSection();
    this.renderCalendar();

    // Manual listeners. Defer the outside-click binding to the next frame so the opening click doesn't immediately close the popup
    window.setTimeout(() => {
      if (!this.popupOpen) return;
      document.addEventListener("mousedown", this.onOutsideClick, true);
    }, 0);
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  closePopup() {
    // Always tear down listeners even if popup element is gone
    document.removeEventListener("mousedown", this.onOutsideClick, true);
    document.removeEventListener("keydown", this.onKeyDown, true);

    if (this.sw.tickInterval) {
      window.clearInterval(this.sw.tickInterval);
      this.sw.tickInterval = null;
    }

    if (this.popupEl) {
      this.popupEl.remove();
      this.popupEl = null;
    }
    this.sw.displayEl = null;
    this.historyEl = null;
    this.timerBodyEl = null;
    this.secTitleEl = null;
    this.modeBtnEl = null;
    this.cdBtnEl = null;
    this.labelInputEl = null;
    this.cdEditing = false;
    this.calGridEl = null;
    this.calLabelEl = null;
    this.calDowEl = null;
    this.popupOpen = false;
  }

  positionPopup() {
    if (!this.popupEl || !this.clockEl) return;
    const rect = this.clockEl.getBoundingClientRect();
    const popupWidth = 260;
    let left = rect.right - popupWidth;
    if (left < 8) left = 8;
    const maxLeft = window.innerWidth - popupWidth - 8;
    if (left > maxLeft) left = maxLeft;
    this.popupEl.style.position = "fixed";
    this.popupEl.style.top = rect.bottom + 6 + "px";
    this.popupEl.style.left = left + "px";
    this.popupEl.style.width = popupWidth + "px";
  }

  // Timer section (stopwatch / countdown share the display + label + Log)

  renderTimerSection() {
    if (!this.timerBodyEl) return;
    const mode = this.timerMode;
    if (this.secTitleEl) {
      this.secTitleEl.textContent = mode === "countdown" ? "Pomodoro" : "Stopwatch";
    }
    if (this.modeBtnEl) {
      this.modeBtnEl.textContent = mode === "countdown" ? "Stopwatch" : "Pomodoro";
    }
    const body = this.timerBodyEl;
    body.empty();
    this.cdBtnEl = null;
    this.historyEl = null;
    this.cdEditing = false;

    const display = body.createDiv({ cls: "forest-sw-display" });
    this.sw.displayEl = display;
    if (mode === "countdown") {
      display.addClass("forest-cd");
      display.setAttribute("title", "Click to set a custom duration");
      display.setAttribute("aria-label", "Click to set a custom duration");
      this.registerDomEvent(display, "click", () => this.beginCdEdit());
    }
    this.updateTimerDisplay();

    // Session label; defaults to the active note until the user edits it
    const labelIn = body.createEl("input", {
      cls: "forest-sw-label",
      type: "text",
    });
    labelIn.placeholder = "Session label";
    const active = this.app.workspace.getActiveFile();
    labelIn.value = this.labelDirty
      ? this.sessionLabel
      : active
      ? active.basename
      : "";
    this.sessionLabel = labelIn.value;
    this.labelInputEl = labelIn;
    this.registerDomEvent(labelIn, "input", () => {
      this.labelDirty = true;
      this.sessionLabel = labelIn.value;
    });

    const buttons = body.createDiv({ cls: "forest-sw-buttons" });
    if (mode === "countdown") {
      const b5 = buttons.createEl("button", { text: "5m" });
      const b15 = buttons.createEl("button", { text: "15m" });
      const startBtn = buttons.createEl("button", {
        text: this.cd.running ? "Pause" : "Start",
      });
      const resetBtn = buttons.createEl("button", { text: "Reset" });
      buttons.createDiv({ cls: "forest-sw-sep" });
      const logBtn = buttons.createEl("button", { text: "Log" });
      this.cdBtnEl = startBtn;
      this.registerDomEvent(b5, "click", () => this.cdSet(5 * 60 * 1000));
      this.registerDomEvent(b15, "click", () => this.cdSet(15 * 60 * 1000));
      this.registerDomEvent(startBtn, "click", () =>
        this.cd.running ? this.cdPause() : this.cdStart()
      );
      this.registerDomEvent(resetBtn, "click", () => this.cdReset());
      this.registerDomEvent(logBtn, "click", () => this.logSession());
    } else {
      const startBtn = buttons.createEl("button", { text: "Start" });
      const stopBtn = buttons.createEl("button", { text: "Stop" });
      const resetBtn = buttons.createEl("button", { text: "Reset" });
      buttons.createDiv({ cls: "forest-sw-sep" });
      const logBtn = buttons.createEl("button", { text: "Log" });
      this.registerDomEvent(startBtn, "click", () => this.swStart());
      this.registerDomEvent(stopBtn, "click", () => this.swStop());
      this.registerDomEvent(resetBtn, "click", () => this.swReset());
      this.registerDomEvent(logBtn, "click", () => this.logSession());

      // Run history chips
      this.historyEl = body.createDiv({ cls: "forest-sw-history" });
      this.renderHistory();
    }

    this.maybeStartSwTick();
  }

  // Stopwatch logic

  swElapsed() {
    let total = this.sw.accumulated;
    if (this.sw.running) {
      total += Date.now() - this.sw.startTime;
    }
    return total;
  }

  formatStopwatch(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    if (h > 0) {
      return h + ":" + pad(m) + ":" + pad(s);
    }
    return pad(m) + ":" + pad(s);
  }

  swStart() {
    if (this.sw.running) return;
    this.sw.running = true;
    this.sw.startTime = Date.now();
    this.persist();
    this.updateTimerDisplay();
    this.maybeStartSwTick();
    this.refreshHeader();
  }

  swStop() {
    if (!this.sw.running) return;
    this.sw.accumulated += Date.now() - this.sw.startTime;
    this.sw.running = false;
    this.stopTickIfIdle();
    this.persist();
    this.updateTimerDisplay();
    this.refreshHeader();
  }

  swReset() {
    // Finalize the current run into history before clearing
    const elapsed = this.swElapsed();
    if (elapsed > 0) this.pushHistory(elapsed);
    this.sw.running = false;
    this.sw.accumulated = 0;
    this.sw.startTime = 0;
    this.stopTickIfIdle();
    this.persist();
    this.updateTimerDisplay();
    this.renderHistory();
    this.refreshHeader();
  }

  pushHistory(ms) {
    this.history.unshift({ ms, ended: Date.now(), label: this.effectiveLabel() });
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(0, MAX_HISTORY);
    }
  }

  // Load a past run back into the live display (stopped). Start resumes from it; Log records it.
  // A live run is pushed to history first, never silently discarded
  loadRun(run) {
    const current = this.swElapsed();
    if (current > 0) this.pushHistory(current);
    this.sw.running = false;
    this.sw.startTime = 0;
    this.sw.accumulated = run.ms;
    if (run.label) {
      this.sessionLabel = run.label;
      this.labelDirty = true;
      if (this.labelInputEl) this.labelInputEl.value = run.label;
    }
    this.stopTickIfIdle();
    this.persist();
    this.updateTimerDisplay();
    this.renderHistory();
    this.refreshHeader();
  }

  // Countdown logic

  cdRemaining() {
    if (this.cd.running) return Math.max(0, this.cd.endTime - Date.now());
    return this.cd.remaining;
  }

  cdStart() {
    if (this.cd.running) return;
    const rem = this.cd.remaining > 0 ? this.cd.remaining : this.cd.setMs;
    this.cd.endTime = Date.now() + rem;
    this.cd.running = true;
    if (this.cdBtnEl) this.cdBtnEl.textContent = "Pause";
    this.persist();
    this.updateTimerDisplay();
    this.maybeStartSwTick();
    this.refreshHeader();
  }

  cdPause() {
    if (!this.cd.running) return;
    this.cd.remaining = this.cdRemaining();
    this.cd.running = false;
    this.cd.endTime = 0;
    if (this.cdBtnEl) this.cdBtnEl.textContent = "Start";
    this.stopTickIfIdle();
    this.persist();
    this.updateTimerDisplay();
    this.refreshHeader();
  }

  cdReset() {
    this.cd.running = false;
    this.cd.endTime = 0;
    this.cd.remaining = this.cd.setMs;
    if (this.cdBtnEl) this.cdBtnEl.textContent = "Start";
    this.stopTickIfIdle();
    this.persist();
    this.updateTimerDisplay();
    this.refreshHeader();
  }

  cdSet(ms) {
    this.cd.setMs = ms;
    this.cd.remaining = ms;
    this.cd.running = false;
    this.cd.endTime = 0;
    if (this.cdBtnEl) this.cdBtnEl.textContent = "Start";
    this.stopTickIfIdle();
    this.persist();
    this.updateTimerDisplay();
    this.refreshHeader();
  }

  // Fires from the 1s interval (and the popup tick), so completion is caught
  // even with the popup closed
  checkCountdown() {
    if (!this.cd.running || this.cd.endTime - Date.now() > 0) return;
    this.cd.running = false;
    this.cd.endTime = 0;
    this.cd.remaining = 0;
    if (this.cdBtnEl) this.cdBtnEl.textContent = "Start";
    this.stopTickIfIdle();
    this.persist();
    new Notice("Timer done — " + this.formatStopwatch(this.cd.setMs));
    this.updateTimerDisplay();
    this.refreshHeader();
  }

  // Click the countdown display to type a custom duration
  beginCdEdit() {
    if (this.cd.running || this.cdEditing || !this.sw.displayEl) return;
    const display = this.sw.displayEl;
    this.cdEditing = true;
    display.empty();
    const input = display.createEl("input", {
      cls: "forest-cd-edit",
      type: "text",
    });
    input.value = this.formatStopwatch(this.cd.setMs);
    input.setAttribute("aria-label", "Countdown duration");
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    const finish = (commit) => {
      if (!this.cdEditing) return;
      this.cdEditing = false;
      const ms = commit ? this.parseDuration(input.value) : null;
      if (ms) {
        this.cdSet(Math.min(Math.max(ms, 1000), MAX_COUNTDOWN));
      } else {
        this.updateTimerDisplay();
      }
    };
    this.registerDomEvent(input, "keydown", (evt) => {
      if (evt.key === "Enter") finish(true);
      else if (evt.key === "Escape") finish(false);
      evt.stopPropagation();
    });
    this.registerDomEvent(input, "blur", () => finish(true));
    this.registerDomEvent(input, "click", (evt) => evt.stopPropagation());
  }

  // "25" = minutes; "25:00", "1:30:00"; "1h30m", "90s" also accepted
  parseDuration(str) {
    const s = (str || "").trim().toLowerCase();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d+)$/))) return +m[1] * 60 * 1000;
    if ((m = s.match(/^(\d+):(\d{1,2})$/))) {
      return (+m[1] * 60 + +m[2]) * 1000;
    }
    if ((m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/))) {
      return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
    }
    let total = 0;
    let found = false;
    const re = /(\d+)\s*(h|m|s)/g;
    let part;
    while ((part = re.exec(s))) {
      found = true;
      total +=
        +part[1] *
        (part[2] === "h" ? 3600000 : part[2] === "m" ? 60000 : 1000);
    }
    return found && total > 0 ? total : null;
  }

  // Shared display tick

  maybeStartSwTick() {
    // Smooth ~100ms updates only while something runs + popup open
    if (
      (this.sw.running || this.cd.running) &&
      this.popupOpen &&
      !this.sw.tickInterval
    ) {
      this.sw.tickInterval = window.setInterval(() => {
        this.checkCountdown();
        this.updateTimerDisplay();
      }, 100);
    }
  }

  stopTickIfIdle() {
    if (!this.sw.running && !this.cd.running && this.sw.tickInterval) {
      window.clearInterval(this.sw.tickInterval);
      this.sw.tickInterval = null;
    }
  }

  updateTimerDisplay() {
    if (!this.sw.displayEl || this.cdEditing) return;
    const ms =
      this.timerMode === "countdown" ? this.cdRemaining() : this.swElapsed();
    this.sw.displayEl.textContent = this.formatStopwatch(ms);
  }

  renderHistory() {
    if (!this.historyEl) return;
    this.historyEl.empty();
    this.history.forEach((run, i) => {
      const chip = this.historyEl.createDiv({ cls: "forest-sw-chip" });
      chip.createSpan({ cls: "forest-sw-chip-num", text: String(i + 1) });
      chip.createSpan({
        cls: "forest-sw-chip-dur",
        text: this.formatStopwatch(run.ms),
      });
      if (run.label) chip.setAttribute("title", run.label);
      this.registerDomEvent(chip, "click", () => this.loadRun(run));
    });
  }

  // Note writing

  effectiveLabel() {
    if (this.labelDirty) return (this.sessionLabel || "").trim();
    const f = this.app.workspace.getActiveFile();
    return f ? f.basename : "";
  }

  insertTimestamp() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) {
      new Notice("No active note");
      return;
    }
    view.editor.replaceSelection(this.formatClock(new Date()));
  }

  sessionLine(ms, label) {
    let line = "- ⏱ " + this.formatStopwatch(ms);
    if (label) line += " — " + label;
    return line + " — logged " + this.formatClock(new Date());
  }

  async logSession() {
    const ms =
      this.timerMode === "countdown"
        ? Math.max(0, this.cd.setMs - this.cdRemaining())
        : this.swElapsed();
    if (ms <= 0) {
      new Notice("Timer is at zero");
      return;
    }
    const line = this.sessionLine(ms, this.effectiveLabel());

    if (this.settings.logTarget === "active") {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.editor) {
        view.editor.replaceSelection(line + "\n");
        new Notice("Session logged");
      } else {
        new Notice("No active note to log to");
      }
      return;
    }

    // Daily note: append to the end
    const file = await this.resolveDailyNote(this.nowDate());
    if (file) {
      await this.app.vault.append(file, "\n" + line);
      new Notice("Session logged to daily note");
    } else {
      new Notice("Could not open daily note");
    }
  }

  // Daily notes (reads core Daily Notes settings; dependency-free)

  getDailyNoteConfig() {
    let format = "YYYY-MM-DD";
    let folder = "";
    let template = "";
    try {
      const dn = this.app.internalPlugins.getPluginById("daily-notes");
      const opts = dn && dn.instance && dn.instance.options;
      if (opts) {
        if (opts.format) format = opts.format;
        if (opts.folder) folder = opts.folder;
        if (opts.template) template = opts.template;
      }
    } catch (e) {
      // fall back to defaults
    }
    return { format, folder, template };
  }

  dailyNotePath(dateObj) {
    const { format, folder } = this.getDailyNoteConfig();
    const name = moment(dateObj).format(format);
    const dir = folder ? folder.replace(/\/+$/, "") + "/" : "";
    return dir + name + ".md";
  }

  hasDailyNote(year, month, day) {
    const path = this.dailyNotePath(new Date(year, month, day));
    return !!this.app.vault.getAbstractFileByPath(path);
  }

  async resolveDailyNote(dateObj) {
    const path = this.dailyNotePath(dateObj);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) return file;
    return this.createDailyNote(path, dateObj);
  }

  // Expand the template variables core Daily Notes supports:
  // {{date}} / {{date:FORMAT}}, {{time}} / {{time:FORMAT}}, {{title}}
  expandTemplate(content, dateObj) {
    const day = moment(dateObj);
    const now = moment();
    const { format } = this.getDailyNoteConfig();
    return content
      .replace(/{{\s*date\s*(?::([^}]*))?\s*}}/gi, (_, f) =>
        day.format((f || "").trim() || "YYYY-MM-DD")
      )
      .replace(/{{\s*time\s*(?::([^}]*))?\s*}}/gi, (_, f) =>
        now.format((f || "").trim() || "HH:mm")
      )
      .replace(/{{\s*title\s*}}/gi, day.format(format));
  }

  async createDailyNote(path, dateObj) {
    const { template, folder } = this.getDailyNoteConfig();

    // Ensure the daily-notes folder exists.
    if (folder) {
      const dir = folder.replace(/\/+$/, "");
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
        try {
          await this.app.vault.createFolder(dir);
        } catch (e) {
          // already exists / created concurrently
        }
      }
    }

    // Seed with the configured template, {{date}}/{{time}}/{{title}} expanded
    let content = "";
    if (template) {
      const tplPath = template.endsWith(".md") ? template : template + ".md";
      const tplFile = this.app.vault.getAbstractFileByPath(tplPath);
      if (tplFile) {
        try {
          content = this.expandTemplate(
            await this.app.vault.read(tplFile),
            dateObj
          );
        } catch (e) {
          content = "";
        }
      }
    }

    try {
      return await this.app.vault.create(path, content);
    } catch (e) {
      // Lost a creation race, return whatever now exists at the path.
      return this.app.vault.getAbstractFileByPath(path);
    }
  }

  async openDailyNote(dateObj, paneType) {
    const file = await this.resolveDailyNote(dateObj);
    if (file) {
      await this.app.workspace.getLeaf(paneType || false).openFile(file);
    } else {
      new Notice("Could not open daily note");
    }
  }

  // Calendar logic

  renderCalendar() {
    if (!this.calGridEl || !this.calLabelEl) return;

    const fdow = this.settings.firstDayOfWeek; // 0 = Sun, 1 = Mon

    // Day-of-week header, rotated to the configured first day
    if (this.calDowEl) {
      this.calDowEl.empty();
      const base = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
      const labels = base.slice(fdow).concat(base.slice(0, fdow));
      labels.forEach((d) => {
        this.calDowEl.createDiv({
          cls: "forest-cal-cell forest-cal-dowcell",
          text: d,
        });
      });
    }

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    this.calLabelEl.textContent =
      monthNames[this.calMonth] + " " + this.calYear;

    this.calGridEl.empty();

    const firstDay = new Date(this.calYear, this.calMonth, 1).getDay(); // 0=Sun
    const offset = (firstDay - fdow + 7) % 7;
    const daysInMonth = new Date(this.calYear, this.calMonth + 1, 0).getDate();

    const np = this.nowParts();
    const isCurrentMonth = np.y === this.calYear && np.m === this.calMonth;
    const todayDate = np.day;

    // Leading blanks for first-day offset
    for (let i = 0; i < offset; i++) {
      this.calGridEl.createDiv({ cls: "forest-cal-cell forest-cal-blank" });
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const cell = this.calGridEl.createDiv({
        cls: "forest-cal-cell forest-cal-day",
        text: "" + day,
      });
      if (isCurrentMonth && day === todayDate) {
        cell.addClass("forest-cal-today");
      }
      if (this.hasDailyNote(this.calYear, this.calMonth, day)) {
        cell.createSpan({ cls: "forest-cal-dot" });
      }
      this.registerDomEvent(cell, "click", (evt) => {
        // Ctrl/Cmd-click opens in a new tab
        this.openDailyNote(
          new Date(this.calYear, this.calMonth, day),
          Keymap.isModEvent(evt)
        );
        this.closePopup();
      });
    }
  }
};

class ClockSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("24-hour time")
      .setDesc("Show the clock in 24-hour format instead of AM/PM.")
      .addToggle((t) =>
        t.setValue(s.use24Hour).onChange(async (v) => {
          s.use24Hour = v;
          this.plugin.persist();
          this.plugin.refreshHeader();
        })
      );

    new Setting(containerEl)
      .setName("First day of week")
      .setDesc("Which day the calendar week starts on.")
      .addDropdown((d) =>
        d
          .addOption("0", "Sunday")
          .addOption("1", "Monday")
          .setValue(String(s.firstDayOfWeek))
          .onChange(async (v) => {
            s.firstDayOfWeek = parseInt(v, 10);
            this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("Timezone")
      .setDesc(
        "The clock follows your system timezone automatically. Override to display a specific zone."
      )
      .addDropdown((d) => {
        d.addOption("", "System (auto)");
        let zones = [];
        try {
          zones = Intl.supportedValuesOf("timeZone");
        } catch (e) {
          zones = FALLBACK_ZONES;
        }
        if (!zones || !zones.length) zones = FALLBACK_ZONES;
        zones.forEach((z) => d.addOption(z, z));
        d.setValue(s.timezone);
        d.onChange(async (v) => {
          s.timezone = v;
          this.plugin.persist();
          this.plugin.refreshHeader();
        });
      });

    new Setting(containerEl)
      .setName("Session log target")
      .setDesc("Where the Log button writes a session.")
      .addDropdown((d) =>
        d
          .addOption("daily", "Daily note")
          .addOption("active", "Active note")
          .setValue(s.logTarget)
          .onChange(async (v) => {
            s.logTarget = v;
            this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("Header shows while running")
      .setDesc(
        "What the header displays while a stopwatch or countdown is running."
      )
      .addDropdown((d) =>
        d
          .addOption("clock", "Clock + dot")
          .addOption("timer", "Timer replaces clock")
          .addOption("both", "Clock | timer")
          .setValue(s.headerDisplay)
          .onChange(async (v) => {
            s.headerDisplay = v;
            this.plugin.persist();
            this.plugin.refreshHeader();
          })
      );

    new Setting(containerEl).setName("Appearance").setHeading();

    new Setting(containerEl)
      .setName("Bold clock")
      .setDesc("Show the current time in the header in bold.")
      .addToggle((t) =>
        t.setValue(s.boldClock).onChange(async (v) => {
          s.boldClock = v;
          this.plugin.persist();
          this.plugin.applyAccent();
        })
      );

    new Setting(containerEl)
      .setName("Accent")
      .setDesc(
        "Follow the theme accent (default), or override with a custom color or gradient."
      )
      .addDropdown((d) =>
        d
          .addOption("theme", "Follow theme")
          .addOption("color", "Custom color")
          .addOption("gradient", "Gradient")
          .setValue(s.accentMode)
          .onChange(async (v) => {
            s.accentMode = v;
            this.plugin.persist();
            this.plugin.applyAccent();
            this.display();
          })
      );

    if (s.accentMode === "color") {
      new Setting(containerEl)
        .setName("Accent color")
        .addColorPicker((c) =>
          c.setValue(s.accentColor).onChange(async (v) => {
            s.accentColor = v;
            this.plugin.persist();
            this.plugin.applyAccent();
          })
        );
    }

    if (s.accentMode === "gradient") {
      new Setting(containerEl)
        .setName("Colorway")
        .addDropdown((d) => {
          d.addOption("forest", "Forest")
            .addOption("sunset", "Sunset")
            .addOption("ocean", "Ocean")
            .addOption("candy", "Candy")
            .addOption("ember", "Ember")
            .addOption("mono", "Mono")
            .addOption("custom", "Custom")
            .setValue(s.gradientPreset)
            .onChange(async (v) => {
              s.gradientPreset = v;
              this.plugin.persist();
              this.plugin.applyAccent();
              this.display();
            });
        });

      if (s.gradientPreset === "custom") {
        new Setting(containerEl)
          .setName("Gradient stops")
          .setDesc("Start and end colors.")
          .addColorPicker((c) =>
            c.setValue(s.gradientA).onChange(async (v) => {
              s.gradientA = v;
              this.plugin.persist();
              this.plugin.applyAccent();
            })
          )
          .addColorPicker((c) =>
            c.setValue(s.gradientB).onChange(async (v) => {
              s.gradientB = v;
              this.plugin.persist();
              this.plugin.applyAccent();
            })
          );
      }
    }

    if (s.accentMode !== "theme") {
      new Setting(containerEl)
        .setName("Color the header clock")
        .setDesc(
          "Apply the accent to the running timer in the header. Off keeps the header theme-native."
        )
        .addToggle((t) =>
          t.setValue(s.colorHeaderTimer).onChange(async (v) => {
            s.colorHeaderTimer = v;
            this.plugin.persist();
            this.plugin.applyAccent();
            this.plugin.refreshHeader();
          })
        );
    }
  }
}
