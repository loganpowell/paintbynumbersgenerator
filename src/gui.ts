/**
 * Module that provides function the GUI uses and updates the DOM accordingly
 */

import { CancellationToken, delay, IMap, RGB } from "./common";
import { GUIProcessManager, ProcessResult } from "./guiprocessmanager";
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
      const fontColor = $("#txtLabelFontColor").val() + "";

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
 * Cached parsed Hershey glyph data (fetched once per page load).
 * Maps a unicode character to { d: path data string, advanceWidth: number }.
 */
let hersheyGlyphs: Map<string, { d: string; advanceWidth: number }> | null =
  null;
const HERSHEY_UNITS_PER_EM = 1000;
const HERSHEY_CAP_HEIGHT = 500; // cap-height from font-face metadata

async function ensureHersheyGlyphs(): Promise<
  Map<string, { d: string; advanceWidth: number }>
> {
  if (hersheyGlyphs) return hersheyGlyphs;

  const resp = await fetch("fonts/HersheySans1.svg");
  if (!resp.ok)
    throw new Error(`Failed to fetch HersheySans1.svg: HTTP ${resp.status}`);
  const text = await resp.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "image/svg+xml");

  hersheyGlyphs = new Map();
  for (const glyph of Array.from(doc.querySelectorAll("glyph"))) {
    const unicode = glyph.getAttribute("unicode");
    const d = glyph.getAttribute("d");
    const advW = glyph.getAttribute("horiz-adv-x");
    if (unicode && d && advW) {
      hersheyGlyphs.set(unicode, {
        d,
        advanceWidth: parseFloat(advW),
      });
    }
  }
  return hersheyGlyphs;
}

/**
 * Replaces all <text> elements in svgEl with Hershey single-stroke <path>
 * elements. Paths use fill="none" + stroke, making them true open-path output
 * suitable for CNC plotters, laser engravers, and Inkscape.
 */
async function textLabelsToHersheyPaths(svgEl: SVGSVGElement): Promise<void> {
  const glyphs = await ensureHersheyGlyphs();
  const xmlns = "http://www.w3.org/2000/svg";
  const scale_factor = 1 / HERSHEY_UNITS_PER_EM;
  // cap height in normalised units (0..1)
  const capNorm = HERSHEY_CAP_HEIGHT * scale_factor;

  const textEls = Array.from(
    svgEl.querySelectorAll("text"),
  ) as SVGTextElement[];

  for (const textEl of textEls) {
    const text = textEl.textContent ?? "";
    if (!text) continue;

    const cx = parseFloat(textEl.getAttribute("x") ?? "0");
    const cy = parseFloat(textEl.getAttribute("y") ?? "0");
    const fontSize = parseFloat(textEl.getAttribute("font-size") ?? "12");
    const strokeColor = textEl.getAttribute("fill") ?? "black";
    // Stroke width scales with font size: ~8% of em gives good weight at all
    // label sizes without obscuring the numeral. Floor at 0.5px for tiny facets.
    const strokeWidth = Math.max(3, fontSize);

    // Compute total advance width in SVG pixels so we can centre the string
    let totalAdvance = 0;
    for (const ch of text) {
      const g = glyphs.get(ch);
      totalAdvance += g
        ? g.advanceWidth * scale_factor * fontSize
        : fontSize * 0.6;
    }

    // SVG text uses dominant-baseline:middle, so cy is the vertical centre.
    // The Hershey glyph coordinate system has y=0 at the baseline, y increases UP.
    // Cap-height centre = baseline + HERSHEY_CAP_HEIGHT/2 (in font units).
    // In SVG (y-down): baseline_y = cy + (capNorm * fontSize) / 2
    const baselineSvgY = cy + (capNorm * fontSize) / 2;
    let curX = cx - totalAdvance / 2;

    const g = document.createElementNS(xmlns, "g");

    for (const ch of text) {
      const glyph = glyphs.get(ch);
      if (!glyph) {
        curX += fontSize * 0.6;
        continue;
      }
      const advPx = glyph.advanceWidth * scale_factor * fontSize;
      const s = scale_factor * fontSize;

      const pathEl = document.createElementNS(xmlns, "path");
      pathEl.setAttribute("d", glyph.d);
      pathEl.setAttribute("fill", "none");
      pathEl.setAttribute("stroke", strokeColor);
      pathEl.setAttribute("stroke-width", strokeWidth + "");
      pathEl.setAttribute("stroke-linecap", "round");
      pathEl.setAttribute("stroke-linejoin", "round");
      // Translate glyph origin to curX / baselineSvgY, flip Y axis (font Y-up → SVG Y-down)
      pathEl.setAttribute(
        "transform",
        `translate(${curX},${baselineSvgY}) scale(${s},${-s})`,
      );
      g.appendChild(pathEl);
      curX += advPx;
    }

    textEl.parentNode!.replaceChild(g, textEl);
  }
}

export async function downloadSVG() {
  pendingUpdate = true;
  while (isUpdatingOutput) await delay(50);
  await updateOutput();
  if ($("#svgContainer svg").length > 0) {
    const svgEl = $("#svgContainer svg").get(0) as unknown as SVGSVGElement;
    svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");

    const renderAsPaths = (
      document.getElementById("chkRenderLabelsAsPaths") as HTMLInputElement
    ).checked;

    if (renderAsPaths) {
      // Convert <text> nodes to Hershey single-stroke <path> outlines
      await textLabelsToHersheyPaths(svgEl);
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
