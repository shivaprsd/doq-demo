/* Initialisation */
if (document.readyState === "interactive" || document.readyState === "complete") {
  doqInit();
} else {
  document.addEventListener("DOMContentLoaded", doqInit, true);
}
async function doqInit() {
  let path = (new URL(import.meta.url)).pathname;
  path = path.substring(0, path.lastIndexOf("/") + 1);
  const colors = await fetch(path + "colors.json").then(resp => resp.json());
  linkCSS(path + "doq.css");
  fetch(path + "doq.html")
    .then(response => response.text()).then(installAddon)
    .then(() => {
      /* window.DOQReader = DOQReader; */
      DOQReader.load(colors);
    });
  function installAddon(html) {
    const docFrag = document.createRange().createContextualFragment(html);
    const toolbar = document.getElementById("toolbarViewerRight");
    toolbar.prepend(docFrag.getElementById("toolbarAddon").content);
    const mainContainer = document.getElementById("mainContainer");
    mainContainer.insertBefore(docFrag.getElementById("mainAddon").content,
                               mainContainer.querySelector("#viewerContainer"));
  }
  function linkCSS(href) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
}
import {Color} from "./lib/color.js";
const newColor = (arg) => new Color(arg);

const DOQReader = {
  config: {},
  preferences: {},
  colorSchemes: [],
  readerTone: {},
  canvasData: null,
  styleCache: new Map(),
  flags: { readerOn: false, autoReader: true, isPrinting: false },

  getDefaultPrefs() {
    return {
      scheme: 1, tone: "1", imageMode: "blendImage",
      flags: { invertOn: false, shapesOn: true, imagesOn: false }
    };
  },
  getDoqConfig() {
    return {
      sysTheme: window.matchMedia("(prefers-color-scheme: light)"),
      docStyle: document.documentElement.style,
      viewReader: document.getElementById("viewReader"),
      readerToolbar: document.getElementById("readerToolbar"),
      readerSwitch: document.getElementById("readerSwitch"),
      schemeSelector: document.getElementById("schemeSelect"),
      tonePicker: document.getElementById("tonePicker"),
      invertToggle: document.getElementById("invertToggle"),
      shapeToggle: document.getElementById("shapeEnable"),
      imageToggle: document.getElementById("imageEnable"),
      imageMode: document.getElementById("imageMode"),
      viewerClassList: document.getElementById("outerContainer").classList
    };
  },

  load(colorSchemes) {
    this.config = this.getDoqConfig();
    colorSchemes.forEach(scheme => {
      this.config.schemeSelector.innerHTML += `<option>${scheme.name}</option>`;
      scheme.tones.forEach(tone => {
        const [b, f] = [tone.background, tone.foreground].map(newColor);
        tone.colors = {
          bg: b, fg: f, grad: b.range(f),
          acc: (tone.accents || []).map(newColor)
        };
        tone.scheme = scheme;
      });
      scheme.colors = (scheme.accents || []).map(newColor);
    });
    this.colorSchemes = colorSchemes;
    this.updateReaderState();

    /* Event listeners */
    this.config.sysTheme.onchange = this.updateReaderState.bind(this);
    this.config.schemeSelector.onchange = e => {
      this.updateColorScheme(e.target.selectedIndex);
    };
    this.config.tonePicker.onchange = this.updateReaderColors.bind(this);
    this.config.imageMode.onchange = this.updateImageMode.bind(this);
    this.config.viewReader.onclick = this.toggleToolbar.bind(this);
    this.config.readerSwitch.onchange = this.toggleReader.bind(this);
    this.config.shapeToggle.onchange = this.config.imageToggle.onchange
                                     = this.toggleFlags.bind(this);
    this.config.invertToggle.onchange = this.toggleInvert.bind(this);
    this.config.readerToolbar.onkeydown = this.handleKeyDown.bind(this);
    this.config.schemeSelector.onclick = e => {
      this.config.readerToolbar.classList.remove("tabMode");
    };
    this.config.tonePicker.onfocusin = e => {
      const t = e.currentTarget;
      t.contains(e.relatedTarget) || t.elements[this.preferences.tone].focus();
    }
    if (this.flags.autoReader) {
      this.config.readerSwitch.checked = true;
      this.config.readerSwitch.dispatchEvent(new Event("change"));
    }
    window.addEventListener("beforeprint", e => this.flags.isPrinting = true);
    window.addEventListener("afterprint", e => this.flags.isPrinting = false);
    window.addEventListener("click", this.closeToolbar.bind(this));
    window.addEventListener("resize", this.updateToolbarPos.bind(this));
    (new MutationObserver(this.updateToolbarPos.bind(this))).observe(
      this.config.viewReader.parentElement,
      { subtree: true, attributeFilter: ["class", "style", "hidden"] }
    );

    /* Wrap canvas drawing */
    const ctxp = CanvasRenderingContext2D.prototype;
    const test = this.checkFlags.bind(this);
    const cb = this.saveCanvas.bind(this);
    ctxp.origFillRect = ctxp.fillRect;
    ["fill", "stroke"].forEach(f => {
      ["", "Rect", "Text"].forEach(e => {
        ctxp[f + e] = this.wrap(ctxp[f + e], f + "Style",
                                this.getReaderStyle.bind(this), test, cb);
      });
    });
    ctxp.origDrawImage = ctxp.drawImage;
    ctxp.drawImage = this.wrap(ctxp.drawImage, "globalCompositeOperation",
                               this.getReaderCompOp.bind(this), test, cb);
  },

  /* Method wrapper closure */
  wrap(method, prop, getNewVal, test, callback) {
    return function() {
      if (test && !test())
        return method.apply(this, arguments);
      const orig = this[prop];
      this[prop] = getNewVal(this, method, arguments, orig);
      method.apply(this, arguments);
      this[prop] = orig;
      callback && callback(this, method);
    }
  },
  checkFlags() {
    return this.flags.readerOn && !this.flags.isPrinting;
  },
  saveCanvas(ctx, method) {
    const cvs = ctx.canvas;
    if (!method.name.endsWith("Text") && cvs.isConnected)
      this.canvasData = ctx.getImageData(0, 0, cvs.width, cvs.height);
  },

  /* Return fill and stroke styles */
  getReaderStyle(ctx, method, args, style) {
    const isColor = typeof(style) === "string";    /* not gradient/pattern */
    const isText = method.name.endsWith("Text");
    const isShape = !isText && !(
      method.name === "fillRect" &&
      args[2] == ctx.canvas.width &&
      args[3] == ctx.canvas.height
    );
    if (isShape && !this.flags.shapesOn || !isColor)
      return style;
    const bg = isText && this.getCanvasColor(ctx, args[1], args[2]);
    const key = style + (bg ? bg.toHex() : "");
    let newStyle = this.styleCache.get(key);
    if (!newStyle) {
      newStyle = this.calcStyle(newColor(style), bg);
      this.styleCache.set(key, newStyle);
    }
    return newStyle;
  },
  getCanvasColor(ctx, tx, ty) {
    if (!this.canvasData)
      return null;
    const tfm = ctx.getTransform();
    let {x, y} = tfm.transformPoint({x: tx, y: ty});
    [x, y] = [x, y].map(Math.round);
    const i = (y * this.canvasData.width + x) * 4;
    const data = Array.from(this.canvasData.data.slice(i, i + 3));
    return newColor(data.map(e => e / 255));
  },

  /* Calculate a new style for given colorscheme and tone */
  calcStyle(color, textBg) {
    const {bg, fg, grad, acc} = this.readerTone.colors;
    const diffL = clr => Math.abs(clr.lightness - textBg.lightness);
    let style;
    if (color.chroma > 10) {
      const accents = acc.concat(this.readerTone.scheme.colors);
      if (accents.length)
        style = this.findMatch(accents, e => e.deltaE(color), Math.min).toHex();
    } else if (textBg && bg.deltaE(textBg) > 2.3) {
      style = this.findMatch([bg, fg], diffL, Math.max).toHex();
    } else {
      const whiteL = Color.white.lightness;
      style = grad(1 - color.lightness / whiteL).toHex();
    }
    return style;
  },
  findMatch(array, mapFun, condFun) {
    const newArr = array.map(mapFun);
    return array[newArr.indexOf(condFun(...newArr))];
  },

  /* Return image composite operation, drawing an optional mask */
  getReaderCompOp(ctx, drawImage, args, compOp) {
    if (!this.flags.imagesOn || !ctx.canvas.isConnected)
      return compOp;
    const tone = this.readerTone;
    if (tone.colors.bg.lightness < 50 && args.length >= 5) {
      args = [...args];
      const mask = this.createMask(tone.foreground, args.slice(0, 5));
      args.splice(0, 1, mask);
      drawImage.apply(ctx, args);
    }
    compOp = this.config.imageMode.compOp.value;
    return compOp;
  },
  createMask(color, args) {
    const cvs = document.createElement("canvas");
    const dim = [cvs.width, cvs.height] = args.slice(3);
    const ctx = cvs.getContext("2d");
    ctx.fillStyle = color;
    ctx.origFillRect(0, 0, ...dim);
    ctx.globalCompositeOperation = "destination-in";
    ctx.origDrawImage(...args, 0, 0, ...dim);
    return cvs;
  },

  readPreferences() {
    let prefs = this.getDefaultPrefs();
    const theme = this.getSysTheme();
    const store = JSON.parse(localStorage.getItem(`doq.preferences.${theme}`));
    for (const key in store) {
      const value = store[key];
      if (key in prefs && typeof value === typeof prefs[key])
        prefs[key] = value;
    }
    this.preferences = prefs;
    return prefs;
  },
  updatePreference(key, value) {
    let prefs = this.preferences;
    const theme = this.getSysTheme();
    if (key in prefs.flags)
      prefs.flags[key] = this.flags[key];
    else if (key in prefs && typeof value === typeof prefs[key])
      prefs[key] = value;
    localStorage.setItem(`doq.preferences.${theme}`, JSON.stringify(prefs));
  },
  getSysTheme() {
    return this.config.sysTheme.matches ? "light" : "dark";
  },

  /* Event handlers */
  updateReaderState(e) {
    const {invertToggle, imageToggle, shapeToggle,
           imageMode, schemeSelector, viewerClassList} = this.config;
    const prefs = this.readPreferences();
    if (invertToggle.checked = prefs.flags.invertOn) {
      viewerClassList.add("invert");
      this.flags.readerOn = false;
      if (e && !this.flags.invertOn)
        this.forceRedraw();
    } else {
      viewerClassList.remove("invert");
      this.flags.readerOn = viewerClassList.contains("reader");
    }
    imageToggle.checked = prefs.flags.imagesOn;
    shapeToggle.checked = prefs.flags.shapesOn;
    imageMode.elements[prefs.imageMode].checked = true;
    Object.assign(this.flags, prefs.flags);
    schemeSelector.selectedIndex = prefs.scheme;
    this.updateColorScheme(prefs.scheme);
    this.updateToolbarPos();
  },

  updateColorScheme(index) {
    const scheme = this.colorSchemes[index];
    if (!scheme.tones || !scheme.tones.length)
      return;
    const picker = this.config.tonePicker;
    const toneWgt = picker.querySelector("template");
    picker.innerHTML = toneWgt.outerHTML;
    scheme.tones.forEach((tone, index) => {
      const widget = toneWgt.content.cloneNode(true);
      const [input, label] = widget.children;
      input.id = label.htmlFor = "tone" + tone.name;
      input.value = index;
      input.setAttribute("aria-label", tone.name);
      label.title = tone.name;
      label.style.color = tone.foreground;
      label.style.backgroundColor = tone.background;
      picker.appendChild(widget);
    });
    this.config.invertToggle.tabIndex = (scheme.tones.length < 4) ? 29 : 30;
    if (index !== this.preferences.scheme) {
      this.updatePreference("scheme", index);
      this.updatePreference("tone", "0");
    }
    if (!this.flags.invertOn)
      picker.elements[this.preferences.tone].checked = true;
    this.updateReaderColors();
  },

  updateReaderColors(e) {
    const sel = this.config.schemeSelector.selectedIndex;
    const pick = this.config.tonePicker.readerTone.value || this.preferences.tone;
    this.readerTone = this.colorSchemes[sel].tones[pick];
    this.config.docStyle.setProperty("--reader-bg", this.readerTone.background);
    this.updatePreference("tone", pick);
    this.styleCache.clear();
    this.canvasData = null;
    if (e && this.flags.invertOn) {
      this.config.invertToggle.checked = false;
      this.toggleInvert();
    } else if (this.flags.readerOn) {
      this.forceRedraw();
    }
  },
  updateImageMode(e) {
      this.updatePreference("imageMode", e.target.id);
      if (this.flags.readerOn && this.flags.imagesOn)
        this.forceRedraw();
  },
  forceRedraw() {
    const {pdfViewer, pdfThumbnailViewer} = window.PDFViewerApplication;
    pdfViewer._pages.filter(e => e.renderingState).forEach(e => e.reset());
    pdfThumbnailViewer._thumbnails.filter(e => e.renderingState)
                                  .forEach(e => e.reset());
    window.PDFViewerApplication.forceRendering();
  },

  toggleToolbar() {
    this.config.readerToolbar.classList.toggle("hidden");
    this.config.viewReader.classList.toggle("toggled");
    this.toggleTitle(this.config.viewReader);
  },
  toggleReader(e) {
    this.config.viewerClassList.toggle("reader");
    this.toggleTitle(e.target.labels[0]);
    this.flags.readerOn = !this.flags.invertOn && !this.flags.readerOn;
    if (e.isTrusted && !this.flags.invertOn)
      this.forceRedraw();
  },
  toggleFlags(e) {
    const flag = e.target.id.replace("Enable", "sOn");
    this.flags[flag] = e.target.checked;
    this.updatePreference(flag);
    if (this.flags.readerOn)
      this.forceRedraw();
  },
  toggleInvert(e) {
    this.config.viewerClassList.toggle("invert");
    this.flags.invertOn = !this.flags.invertOn;
    this.updatePreference("invertOn");
    if (e) {
      const prefTone = this.config.tonePicker.elements[this.preferences.tone];
      prefTone.checked = !prefTone.checked;
    }
    if (this.config.viewerClassList.contains("reader")) {
      this.flags.readerOn = !this.flags.readerOn;
      this.forceRedraw();
    }
  },

  toggleTitle(elem) {
    const swapPair = elem.dataset.toggleTitle?.split(";", 2);
    if (swapPair) {
      elem.title = elem.title.replace(...swapPair);
      elem.dataset.toggleTitle = swapPair.reverse().join(";");
    }
  },
  handleKeyDown(e) {
    if (e.code === "Tab") {
      this.config.readerToolbar.classList.add("tabMode");
    } else if (e.code === "Escape") {
      this.closeToolbar();
      e.target.blur();
      e.preventDefault();
    }
  },
  closeToolbar(e) {
    const toolbar = this.config.readerToolbar;
    if (toolbar.contains(e?.target) || e?.target === this.config.viewReader)
      return;
    if (!toolbar.classList.contains("hidden"))
      this.toggleToolbar();
  },
  updateToolbarPos() {
    const docWidth = document.documentElement.clientWidth;
    const btnRight = this.config.viewReader.getBoundingClientRect().right;
    const offset = docWidth - Math.ceil(window.pageXOffset + btnRight);
    this.config.readerToolbar.style.right = `${offset + 2}px`;
  }
}
