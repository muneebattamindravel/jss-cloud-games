'use strict';

/**
 * Was this run started on a phone (or tablet), or on a computer?
 *
 * The phone-only rule (founder, 24 Sep 2026): the whole platform stays open on
 * a computer, but a GAME may only be started on a phone or a tablet. Every bot
 * seen so far ran on a computer (an Electron app, a Windows exe driving the real
 * mouse, Selenium rigs), and the players the platform is for are on phones.
 *
 * WHAT THIS CAN AND CANNOT KNOW. Everything except the Client Hints is reported
 * by the page, so a determined author can fake any single field. What this
 * judges is whether the fields AGREE: a phone has touch points, a coarse
 * pointer, a phone GPU and a phone platform string, all at once, and the
 * browser's network layer (Client Hints, which page script cannot touch) says
 * the same thing. A computer pretending to be a phone has to fake every one.
 *
 * It judges the HARDWARE, never the user agent alone:
 *   - an iPad presents a Mac user agent, and an iPhone or Android phone set to
 *     "request desktop site" presents a Mac or Linux one. Touch points and the
 *     GPU still tell the truth, so both are allowed;
 *   - a Windows laptop with a touchscreen has touch points, but it is still a
 *     computer, and its user agent and Client Hints both say Windows;
 *   - an Android emulator on a PC says Android, but its GPU is the PC's.
 *
 * Returns { cls, reasons, claim }:
 *   cls      'phone' | 'tablet' | 'desktop' | 'emulator' | 'unknown'
 *   reasons  plain-words list of what decided it (internal only, never shown
 *            to a player: it would tell a bot author what to fake)
 *
 * Unknown means "not enough to say", never "suspicious". What an unknown is
 * allowed to do is a policy knob, not a verdict.
 */

const { parseUserAgent } = require('../utils/device');

const ALLOWED = new Set(['phone', 'tablet']);

// GPU renderer strings. Mobile first: an Android Chrome renderer reads
// "ANGLE (Qualcomm, Adreno (TM) 610, OpenGL ES 3.2)", which must never be
// mistaken for a desktop ANGLE string. Every iOS browser reports "Apple GPU".
const MOBILE_GPU = /adreno|mali|powervr|apple gpu|xclipse|immortalis|maleoon|vivante|tegra|\bimg\b|videocore|sgx/i;
const DESKTOP_GPU = /nvidia|geforce|quadro|radeon|\bamd\b|\bati\b|intel|iris|uhd graphics|hd graphics|swiftshader|llvmpipe|softpipe|microsoft basic|direct3d|d3d11|d3d9|apple m\d|metal renderer|virgl|vmware|virtualbox|parallels|mesa|gallium|vulkan 1\./i;

// navigator.platform on a computer. NOT "Linux armv8l" / "Linux aarch64":
// that is exactly what Android Chrome reports.
const DESKTOP_PLATFORM = /^(Win32|Win64|Windows|Linux x86_64|Linux i686|MacIntel|MacPPC|X11|CrOS)/i;
const CH_DESKTOP = /^(Windows|macOS|Linux|Chrome OS|Chromium OS)$/i;
// A computer's graphics VENDOR, as opposed to DESKTOP_GPU's wider net (which
// also matches API names like "Vulkan 1." that phones report too).
const PC_GPU_VENDOR = /nvidia|geforce|quadro|radeon|\bamd\b|\bati\b|intel|iris|uhd graphics|hd graphics|swiftshader|llvmpipe|softpipe|microsoft basic|apple m\d|virgl|vmware|virtualbox|parallels/i;

function str(v) { return typeof v === 'string' ? v : ''; }
function num(v) { return Number.isFinite(v) ? v : null; }

/**
 * @param {object} p
 * @param {string} p.userAgent  the request's User-Agent header (never the page's copy)
 * @param {object} [p.claims]   the SDK device snapshot (game_sessions.device_claims)
 * @param {object} [p.ch]       Client Hints read from the request: { ua, mobile, platform }
 */
function classifyPlatform({ userAgent, claims = null, ch = null } = {}) {
  const ua = parseUserAgent(userAgent);
  const c = claims && typeof claims === 'object' ? claims : null;
  const hints = ch || (c && c.ch) || null;
  const reasons = [];
  const tp = c ? num(c.tp) : null;
  const plat = c ? str(c.plat) : '';
  const gl = c && c.gl && typeof c.gl === 'object' ? str(c.gl.r) : '';
  const chPlatform = hints ? str(hints.platform).replace(/"/g, '') : '';
  const chMobile = hints ? str(hints.mobile) : '';
  const claim = { os: ua.os, type: ua.deviceType };

  // ── things only automation or a desktop shell does ─────────────────────
  if (c && c.electron === true) reasons.push('the page runs inside Electron (a desktop app)');
  if (c && c.wd === true) reasons.push('the browser reports it is automated (navigator.webdriver)');
  if (/HeadlessChrome|PhantomJS|SlimerJS/i.test(str(userAgent))) reasons.push('the browser is headless');
  if (reasons.length) return { cls: 'desktop', reasons, claim };

  // The browser's network layer names a computer. Page script cannot change
  // it. ⚠ It does NOT survive "request desktop site" on an Android phone:
  // Chrome then sends platform "Linux", handled by androidDesktopSite below.
  const chSaysDesktop = CH_DESKTOP.test(chPlatform);

  const claimsAndroid = ua.os === 'Android';
  const claimsIOS = ua.os === 'iOS';
  // An iPad, or an iPhone in "request desktop site", presents a Mac user
  // agent. A real Mac has no touch points.
  const macWithTouch = ua.os === 'macOS' && tp !== null && tp > 1;
  // An Android phone in Chrome's "request desktop site" mode presents a Linux
  // user agent AND Client Hints platform "Linux" (measured: faizshiz, 23 Sep).
  // The hardware still says phone: an ARM platform string, touch points and a
  // phone GPU, all three. A Raspberry Pi has no touch points; an ARM
  // Chromebook says CrOS.
  //
  // ⚠ The GPU test is "names a phone GPU and no computer GPU vendor", NOT "no
  // DESKTOP_GPU match at all". Samsung tablets render through ANGLE on Vulkan
  // ("ANGLE (ARM, Mali-G78, Vulkan 1.1.177)"), and "Vulkan 1." is in
  // DESKTOP_GPU, so the old test turned every such tablet into a computer.
  // Large Android tablets open sites in desktop mode BY DEFAULT, so this was
  // not an edge case. (founder, 13 Oct 2026: every phone and tablet plays.)
  const androidDesktopSite = ua.os === 'Linux' && tp !== null && tp > 0
    && /^Linux (armv|aarch64)/i.test(plat) && MOBILE_GPU.test(gl) && !PC_GPU_VENDOR.test(gl);
  const claimsMobile = claimsAndroid || claimsIOS || macWithTouch || androidDesktopSite;

  if (!claimsMobile) {
    // A computer's user agent. Windows, Linux and Chrome OS are computers
    // whatever their screen can do (a touchscreen laptop is still a laptop).
    if (chSaysDesktop) reasons.push(`the browser reports the platform is ${chPlatform}`);
    if (ua.os === 'Windows' || ua.os === 'Linux') reasons.push(`the browser is ${ua.os}`);
    if (ua.os === 'macOS' && tp === 0) reasons.push('the browser is macOS with no touch screen');
    if (plat && DESKTOP_PLATFORM.test(plat) && !(ua.os === 'macOS' && tp === null)) reasons.push(`navigator.platform is ${plat}`);
    if (gl && DESKTOP_GPU.test(gl) && !MOBILE_GPU.test(gl)) reasons.push(`the GPU is a computer's (${gl.slice(0, 60)})`);
    if (reasons.length) return { cls: 'desktop', reasons, claim };
    return { cls: 'unknown', reasons: ['not enough to tell the device apart'], claim };
  }

  // ── it CLAIMS to be a phone or tablet: every field has to agree ─────────
  // Two kinds of finding, kept apart on purpose (founder, 25 Sep 2026):
  //   contra   a lie no real phone tells (Windows Client Hints, a mouse as the
  //            main pointer, a PC graphics card). These decide: 'emulator'.
  //   suspect  a GUESS: evidence measured on ~14 real Android phones, which a
  //            real phone might one day show too. A guess never blocks a
  //            player; it is returned as `suspect` and flagged for review.
  const contra = [];
  const suspect = [];
  if (chSaysDesktop && !(androidDesktopSite && /^Linux$/i.test(chPlatform))) contra.push(`claims ${ua.os} but the browser reports the platform is ${chPlatform}`);
  if (tp === 0) contra.push(`claims ${ua.os} but reports no touch points`);
  if (plat && DESKTOP_PLATFORM.test(plat) && !(plat === 'MacIntel' && (claimsIOS || macWithTouch) && tp !== null && tp > 1)) {
    contra.push(`claims ${ua.os} but navigator.platform is ${plat}`);
  }
  if (gl) {
    if (claimsAndroid && DESKTOP_GPU.test(gl) && !MOBILE_GPU.test(gl)) contra.push(`claims Android but the GPU is a computer's (${gl.slice(0, 60)})`);
    // Every iOS browser is WebKit and reports exactly "Apple GPU". A Mac's
    // Chrome in phone emulation reports "ANGLE (Apple, ... Apple M1 ...)".
    if ((claimsIOS || macWithTouch) && !/^apple gpu$/i.test(gl.trim())) contra.push(`claims an iPhone or iPad but the GPU is "${gl.slice(0, 60)}"`);
  }
  if (claimsIOS && hints && (hints.ua || hints.platform || hints.mobile)) contra.push('claims iOS but the request carried Chromium Client Hints (no iOS browser sends them)');
  if (claimsIOS && c && c.uad) contra.push('claims iOS but exposes userAgentData (no iOS browser has it)');
  // A TABLET may have a trackpad or mouse as its main pointer: an iPad with a
  // Magic Keyboard, a Samsung tablet in a keyboard cover or in DeX. That is a
  // tablet being a tablet, and tablets play (founder, 13 Oct 2026). The other
  // checks (GPU, platform, Client Hints, touch points) still apply to them.
  const looksTablet = ua.deviceType === 'tablet' || macWithTouch || chMobile === '?0';
  if (c && c.hover === 'hover' && c.pointer === 'fine' && !looksTablet) contra.push(`claims ${ua.os || 'a phone'} but the main pointer is a mouse`);
  if (claimsIOS && ua.deviceType !== 'tablet' && c && num(c.sw) !== null && num(c.sh) !== null && Math.max(c.sw, c.sh) > 1100) contra.push(`claims an iPhone but the screen is ${c.sw}x${c.sh}`);
  // An Android emulator on a PC (BlueStacks, 25 Sep 2026) passes everything
  // above: it names a phone GPU ("Adreno (TM) 650"), Android Client Hints and
  // five touch points. What it cannot supply is a motion sensor. Chrome on a
  // real Android phone fires devicemotion with no prompt, within a frame of
  // the listener going on (1,124 of 1,129 production runs had readings).
  //
  // Silence ALONE is not enough: kaalobhai's real phone sent nothing for ten
  // minutes on 23 Sep. So it needs a second sign that phone did not have and
  // the emulator did: a pointer that hovers (a mouse), or a GPU name without
  // the "ANGLE (...)" wrapper Chrome on Android gives it. hulk and nasir show
  // both of those, and their sensors work, so neither sign alone decides
  // anything either. The SDK waits up to 1.5 s for a first reading before a
  // start, so `ms` says how long it listened; under 1.2 s is not enough time.
  const mo = c && c.mo && typeof c.mo === 'object' ? c.mo : null;
  if (claimsAndroid && mo && num(mo.n) === 0 && num(mo.ms) !== null && mo.ms >= 1200
      && c.apis && c.apis.motionEv === true) {
    const signs = [];
    if (c.hover === 'hover') signs.push('a pointer that hovers');
    if (gl && !/^angle \(/i.test(gl.trim())) signs.push(`a GPU name without Chrome's ANGLE wrapper (${gl.slice(0, 40)})`);
    // Silence PLUS a second sign is now a BLOCK, not a flag (founder, 13 Oct
    // 2026: "emulators should still be banned if we can track them"). Every
    // real device measured had at most one of the two: kaalobhai's phone went
    // silent with neither sign; hulk's and nasir's phones hover or name a bare
    // GPU but their sensors work. Only the emulator showed both. Silence on
    // its own still decides nothing.
    if (signs.length) contra.push(`claims Android but its motion sensor sent nothing in ${Math.round(mo.ms / 100) / 10} s, with ${signs.join(' and ')}`);
  }
  if (contra.length) return { cls: 'emulator', reasons: contra, claim };
  const flag = suspect.length ? { suspect } : {};

  const isTablet = ua.deviceType === 'tablet' || macWithTouch || (chMobile === '?0' && !androidDesktopSite);
  // With the SDK snapshot present, a phone has shown touch points and passed
  // every check above.
  if (tp !== null && tp > 0) {
    const why = [`${androidDesktopSite ? 'Android phone in desktop-site mode' : ua.os === 'macOS' ? 'iPad or iPhone' : ua.os} with ${tp} touch points`];
    if (gl) why.push(`GPU ${gl.slice(0, 40)}`);
    if (chPlatform) why.push(`Client Hints platform ${chPlatform}`);
    return { cls: isTablet ? 'tablet' : 'phone', reasons: why, claim, ...flag };
  }
  // No snapshot at all (an old or modified client). The network layer alone
  // can still vouch for an Android phone.
  if (claimsAndroid && /^Android$/i.test(chPlatform) && chMobile === '?1') {
    return { cls: 'phone', reasons: ['Client Hints say an Android phone'], claim, ...flag };
  }
  return { cls: 'unknown', reasons: ['a phone claim with no device snapshot to confirm it'], claim, ...flag };
}

/**
 * The Red Team Lab lets a run start on any device and answers it CAUGHT when
 * the start was classified as a computer or an emulator. `unknown` is not a
 * catch: not being able to tell is never evidence. Reads the verdict stored on
 * the session (device_claims.gate.cls), so it is the verdict made at start.
 */
const LAB_CAUGHT = new Set(['desktop', 'emulator']);
// A suspected emulator plays normally in a real game, but the lab answers it
// CAUGHT: the lab exists to test these guesses, and a tester is never told
// which layer answered.
function labPlatformCaught(gateCls, suspect = null) {
  return LAB_CAUGHT.has(gateCls) || (Array.isArray(suspect) && suspect.length > 0);
}

module.exports = { classifyPlatform, labPlatformCaught, ALLOWED, MOBILE_GPU, DESKTOP_GPU };
