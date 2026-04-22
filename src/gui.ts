/**
 * Module that provides function the GUI uses and updates the DOM accordingly
 */

import { CancellationToken, delay, IMap, RGB } from "./common";
import {
  cachedFontBuffer,
  cachedTTFDataUri,
  ensureLabelFont,
  GUIProcessManager,
  ProcessResult,
} from "./guiprocessmanager";
import { ClusteringColorSpace, Settings } from "./settings";
import { CRAYOLA_64, getCrayolaPaletteSorted } from "./lib/crayola";

declare function saveSvgAsPng(el: Node, filename: string): void;

/**
 * Populates the color restrictions textarea with the Crayola 64 palette
 * and sets colorAliases on the settings so color names are preserved.
 */
export function loadCrayolaPreset(): void {
  const sorted = getCrayolaPaletteSorted();
  const lines: string[] = sorted.map(
    ([name, [r, g, b]]) => `// ${name}\n${r},${g},${b}`,
  );
  const textarea = $("#txtKMeansColorRestrictions");
  textarea.val(lines.join("\n"));
  M.textareaAutoResize(textarea[0] as HTMLTextAreaElement);

  // Render color swatches
  const swatchHtml = sorted
    .map(
      ([name, [r, g, b]]) =>
        `<span title="${name}" style="display:inline-block;width:14px;height:14px;margin:1px;border-radius:2px;background:rgb(${r},${g},${b});border:1px solid rgba(0,0,0,0.15)"></span>`,
    )
    .join("");
  $("#crayolaSwatches").html(swatchHtml).fadeIn(200);

  M.toast({
    html: `Loaded ${lines.length} Crayola colors`,
    displayLength: 2000,
  });
}

let processResult: ProcessResult | null = null;
let cancellationToken: CancellationToken = new CancellationToken();

const timers: IMap<Date> = {};
export function time(name: string) {
  console.time(name);
  timers[name] = new Date();
}

export function timeEnd(name: string) {
  console.timeEnd(name);
  const ms = new Date().getTime() - timers[name].getTime();
  log(name + ": " + ms + "ms");
  delete timers[name];
}

export function log(str: string) {
  $("#log").append("<br/><span>" + str + "</span>");
}

export function parseSettings(): Settings {
  const settings = new Settings();

  if ($("#optColorSpaceRGB").prop("checked")) {
    settings.kMeansClusteringColorSpace = ClusteringColorSpace.RGB;
  } else if ($("#optColorSpaceHSL").prop("checked")) {
    settings.kMeansClusteringColorSpace = ClusteringColorSpace.HSL;
  } else if ($("#optColorSpaceRGB").prop("checked")) {
    settings.kMeansClusteringColorSpace = ClusteringColorSpace.LAB;
  }

  if ($("#optFacetRemovalLargestToSmallest").prop("checked")) {
    settings.removeFacetsFromLargeToSmall = true;
  } else {
    settings.removeFacetsFromLargeToSmall = false;
  }

  settings.randomSeed = parseInt($("#txtRandomSeed").val() + "");
  settings.kMeansNrOfClusters = parseInt($("#txtNrOfClusters").val() + "");
  settings.kMeansMinDeltaDifference = parseFloat(
    $("#txtClusterPrecision").val() + "",
  );

  settings.removeFacetsSmallerThanNrOfPoints = parseInt(
    $("#txtRemoveFacetsSmallerThan").val() + "",
  );
  settings.maximumNumberOfFacets = parseInt(
    $("#txtMaximumNumberOfFacets").val() + "",
  );

  settings.nrOfTimesToHalveBorderSegments = parseInt(
    $("#txtNrOfTimesToHalveBorderSegments").val() + "",
  );

  settings.narrowPixelStripCleanupRuns = parseInt(
    $("#txtNarrowPixelStripCleanupRuns").val() + "",
  );

  settings.resizeImageIfTooLarge = $("#chkResizeImage").prop("checked");
  settings.resizeImageWidth = parseInt($("#txtResizeWidth").val() + "");
  settings.resizeImageHeight = parseInt($("#txtResizeHeight").val() + "");
  settings.sortPaletteByLuminance = $("#chkSortPalette").prop("checked");

  const restrictedColorLines = (
    $("#txtKMeansColorRestrictions").val() + ""
  ).split("\n");
  for (const line of restrictedColorLines) {
    const tline = line.trim();
    if (tline.indexOf("//") === 0) {
      // comment, skip
    } else {
      const rgbparts = tline.split(",");
      if (rgbparts.length === 3) {
        let red = parseInt(rgbparts[0]);
        let green = parseInt(rgbparts[1]);
        let blue = parseInt(rgbparts[2]);
        if (red < 0) red = 0;
        if (red > 255) red = 255;
        if (green < 0) green = 0;
        if (green > 255) green = 255;
        if (blue < 0) blue = 0;
        if (blue > 255) blue = 255;

        if (!isNaN(red) && !isNaN(green) && !isNaN(blue)) {
          settings.kMeansColorRestrictions.push([red, green, blue]);
        }
      }
    }
  }

  return settings;
}

export async function process() {
  try {
    const settings: Settings = parseSettings();
    // cancel old process & create new
    cancellationToken.isCancelled = true;
    cancellationToken = new CancellationToken();
    processResult = await GUIProcessManager.process(
      settings,
      cancellationToken,
    );
    await updateOutput();
    const tabsOutput = M.Tabs.getInstance(
      document.getElementById("tabsOutput")!,
    );
    tabsOutput.select("output-pane");
  } catch (e: any) {
    log("Error: " + e.message + " at " + e.stack);
  }
}

let isUpdatingOutput = false;
let pendingUpdate = false;

export async function updateOutput() {
  if (processResult == null) return;
  if (isUpdatingOutput) {
    pendingUpdate = true;
    return;
  }
  isUpdatingOutput = true;
  try {
    do {
      pendingUpdate = false;
      const showLabels = $("#chkShowLabels").prop("checked");
      const fill = $("#chkFillFacets").prop("checked");
      const stroke = $("#chkShowBorders").prop("checked");

      const sizeMultiplier = parseInt($("#txtSizeMultiplier").val() + "");
      const fontSize = parseInt($("#txtLabelFontSize").val() + "");
      const fontSizeMin = parseInt($("#txtLabelFontSizeMin").val() + "") || 6;
      const fontSizeMax =
        parseInt($("#txtLabelFontSizeMax").val() + "") || Infinity;
      const labelFont = (
        document.getElementById("selLabelFont") as HTMLSelectElement
      ).value;
      const fontColor = $("#txtLabelFontColor").val() + "";

      // Load/register the font before rendering so Chrome can apply it
      const fontFamilyName = await ensureLabelFont(labelFont);

      $("#statusSVGGenerate").css("width", "0%");
      $(".status.SVGGenerate").removeClass("complete");
      $(".status.SVGGenerate").addClass("active");

      const svg = await GUIProcessManager.createSVG(
        processResult.facetResult,
        processResult.colorsByIndex,
        sizeMultiplier,
        fill,
        stroke,
        showLabels,
        fontSize,
        fontColor,
        fontSizeMin,
        fontSizeMax,
        labelFont,
        fontFamilyName,
        (progress) => {
          if (cancellationToken.isCancelled) {
            throw new Error("Cancelled");
          }
          $("#statusSVGGenerate").css(
            "width",
            Math.round(progress * 100) + "%",
          );
        },
      );
      $("#svgContainer").empty().append(svg);
      $("#palette")
        .empty()
        .append(createPaletteHtml(processResult.colorsByIndex));
      ($("#palette .color") as any).tooltip();
      $(".status").removeClass("active");
      $(".status.SVGGenerate").addClass("complete");
    } while (pendingUpdate);
  } finally {
    isUpdatingOutput = false;
  }
}

function createPaletteHtml(colorsByIndex: RGB[]) {
  let html = "";
  for (let c: number = 0; c < colorsByIndex.length; c++) {
    const style =
      "background-color: " +
      `rgb(${colorsByIndex[c][0]},${colorsByIndex[c][1]},${colorsByIndex[c][2]})`;
    html += `<div class="color" class="tooltipped" style="${style}" data-tooltip="${colorsByIndex[c][0]},${colorsByIndex[c][1]},${colorsByIndex[c][2]}">${c}</div>`;
  }
  return $(html);
}

export function downloadPalettePng() {
  if (processResult == null) {
    return;
  }
  const colorsByIndex: RGB[] = processResult.colorsByIndex;

  const canvas = document.createElement("canvas");

  const nrOfItemsPerRow = 10;
  const nrRows = Math.ceil(colorsByIndex.length / nrOfItemsPerRow);
  const margin = 10;
  const cellWidth = 80;
  const cellHeight = 70;

  canvas.width = margin + nrOfItemsPerRow * (cellWidth + margin);
  canvas.height = margin + nrRows * (cellHeight + margin);
  const ctx = canvas.getContext("2d")!;
  ctx.translate(0.5, 0.5);

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < colorsByIndex.length; i++) {
    const color = colorsByIndex[i];

    const x = margin + (i % nrOfItemsPerRow) * (cellWidth + margin);
    const y = margin + Math.floor(i / nrOfItemsPerRow) * (cellHeight + margin);

    ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    ctx.fillRect(x, y, cellWidth, cellHeight - 20);
    ctx.strokeStyle = "#888";
    ctx.strokeRect(x, y, cellWidth, cellHeight - 20);

    const nrText = i + "";
    ctx.fillStyle = "black";
    ctx.strokeStyle = "#CCC";
    ctx.font = "20px Tahoma";
    const nrTextSize = ctx.measureText(nrText);
    ctx.lineWidth = 2;
    ctx.strokeText(
      nrText,
      x + cellWidth / 2 - nrTextSize.width / 2,
      y + cellHeight / 2 - 5,
    );
    ctx.fillText(
      nrText,
      x + cellWidth / 2 - nrTextSize.width / 2,
      y + cellHeight / 2 - 5,
    );
    ctx.lineWidth = 1;

    ctx.font = "10px Tahoma";
    const rgbText =
      "RGB: " +
      Math.floor(color[0]) +
      "," +
      Math.floor(color[1]) +
      "," +
      Math.floor(color[2]);
    const rgbTextSize = ctx.measureText(rgbText);
    ctx.fillStyle = "black";
    ctx.fillText(
      rgbText,
      x + cellWidth / 2 - rgbTextSize.width / 2,
      y + cellHeight - 10,
    );
  }

  const dataURL = canvas.toDataURL("image/png");
  const dl = document.createElement("a");
  document.body.appendChild(dl);
  dl.setAttribute("href", dataURL);
  dl.setAttribute("download", "palette.png");
  dl.click();
}

export async function downloadPNG() {
  // Wait for any in-progress render, then force a fresh one with current settings
  pendingUpdate = true;
  while (isUpdatingOutput) await delay(50);
  await updateOutput();
  if ($("#svgContainer svg").length > 0) {
    saveSvgAsPng($("#svgContainer svg").get(0) as Node, "paintbynumbers.png");
  }
}

/**
 * Replaces all <text> elements in svgEl with equivalent <path> elements using
 * opentype.js glyph outlines. This makes the SVG fully self-contained and
 * compatible with Inkscape / CNC software that can't embed or substitute fonts.
 *
 * Assumes opentype.js is loaded as a global (window.opentype).
 */
function textLabelsToPaths(svgEl: SVGSVGElement, fontBuffer: ArrayBuffer) {
  const opentype = (window as any).opentype;
  if (!opentype) {
    console.warn("[font] opentype.js not available — skipping path conversion");
    return;
  }

  const font = opentype.parse(fontBuffer);
  const unitsPerEm: number = font.unitsPerEm;

  // sCapHeight gives the height of capital letters in font design units.
  // Fallback to ascender if the OS/2 table doesn't have it.
  const capHeightUnits: number =
    font.tables.os2?.sCapHeight || font.ascender || unitsPerEm * 0.7;

  const xmlns = "http://www.w3.org/2000/svg";
  const textEls = Array.from(
    svgEl.querySelectorAll("text"),
  ) as SVGTextElement[];

  for (const textEl of textEls) {
    const text = textEl.textContent ?? "";
    if (!text) continue;

    const cx = parseFloat(textEl.getAttribute("x") ?? "0");
    const cy = parseFloat(textEl.getAttribute("y") ?? "0");
    const fontSize = parseFloat(textEl.getAttribute("font-size") ?? "12");
    const fill = textEl.getAttribute("fill") ?? "black";

    // opentype positions glyphs with y at the baseline (bottom of cap height).
    // Our SVG text uses text-anchor:middle + dominant-baseline:middle, so
    // cx/cy is the visual centre of the label. Convert to opentype's origin:
    //   • x: subtract half the total advance width  (centre → left-edge)
    //   • y: add half the cap height in px          (centre → baseline)
    const advanceWidth = font.getAdvanceWidth(text, fontSize);
    const capHeightPx = (capHeightUnits / unitsPerEm) * fontSize;
    const ox = cx - advanceWidth / 2;
    const oy = cy + capHeightPx / 2;

    const path = font.getPath(text, ox, oy, fontSize);
    const pathData: string = path.toPathData(2);

    const pathEl = document.createElementNS(xmlns, "path");
    pathEl.setAttribute("d", pathData);
    pathEl.setAttribute("fill", fill);
    // Preserve any transform on the text element
    const transform = textEl.getAttribute("transform");
    if (transform) pathEl.setAttribute("transform", transform);

    textEl.parentNode!.replaceChild(pathEl, textEl);
  }
}

export async function downloadSVG() {
  pendingUpdate = true;
  while (isUpdatingOutput) await delay(50);
  await updateOutput();
  if ($("#svgContainer svg").length > 0) {
    const svgEl = $("#svgContainer svg").get(0) as unknown as SVGSVGElement;
    svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");

    const labelFont = (
      document.getElementById("selLabelFont") as HTMLSelectElement
    ).value;
    const renderAsPaths = (
      document.getElementById("chkRenderLabelsAsPaths") as HTMLInputElement
    ).checked;

    if (labelFont === "ttf" && renderAsPaths && cachedFontBuffer) {
      // Convert <text> nodes to <path> outlines — no font embedding needed
      textLabelsToPaths(svgEl, cachedFontBuffer);
    } else if (labelFont === "ttf" && cachedTTFDataUri) {
      // Inject @font-face into <defs> so the downloaded SVG is self-contained
      const xmlns = "http://www.w3.org/2000/svg";
      const fontCss = `@font-face { font-family: 'CNCFont'; src: url('${cachedTTFDataUri}') format('truetype'); }`;
      let defs = svgEl.querySelector("defs") as SVGDefsElement | null;
      if (!defs) {
        defs = document.createElementNS(xmlns, "defs") as SVGDefsElement;
        svgEl.insertBefore(defs, svgEl.firstChild);
      }
      let styleEl = defs.querySelector("style") as SVGStyleElement | null;
      if (!styleEl) {
        styleEl = document.createElementNS(xmlns, "style") as SVGStyleElement;
        styleEl.setAttribute("type", "text/css");
        defs.appendChild(styleEl);
      }
      styleEl.textContent = fontCss;
    }
    const serializer = new XMLSerializer();
    const svgData = serializer.serializeToString(svgEl);
    const preface = '<?xml version="1.0" standalone="no"?>\r\n';
    const svgBlob = new Blob([preface, svgData], {
      type: "image/svg+xml;charset=utf-8",
    });
    const svgUrl = URL.createObjectURL(svgBlob);
    const downloadLink = document.createElement("a");
    downloadLink.href = svgUrl;
    downloadLink.download = "paintbynumbers.svg";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);

    /*
        var svgAsXML = (new XMLSerializer).serializeToString(<any>$("#svgContainer svg").get(0));
        let dataURL = "data:image/svg+xml," + encodeURIComponent(svgAsXML);
        var dl = document.createElement("a");
        document.body.appendChild(dl);
        dl.setAttribute("href", dataURL);
        dl.setAttribute("download", "paintbynumbers.svg");
        dl.click();
        */
  }
}

export function loadExample(imgId: string) {
  // load image
  const img = document.getElementById(imgId) as HTMLImageElement;
  const c = document.getElementById("canvas") as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);
}
