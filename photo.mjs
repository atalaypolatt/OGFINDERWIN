import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } from "@huggingface/transformers";

const root = path.dirname(fileURLToPath(import.meta.url));
env.cacheDir = path.join(root, "data", "models");
env.allowLocalModels = false;

const MODEL = "Xenova/clip-vit-base-patch32";
export const SIMILAR_THRESHOLD = 0.9;

let loading = null;
const byUrl = new Map();
let sampleKey = "";
let sampleVector = null;

function loadModel() {
  if (!loading) {
    loading = buildModel().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

async function buildModel() {
  console.log("photo model loading");
  const processor = await AutoProcessor.from_pretrained(MODEL);
  let vision;
  try {
    vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: "q8", device: "cpu" });
  } catch (error) {
    console.log(`photo model q8 ${error.message}`);
    vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { device: "cpu" });
  }
  console.log("photo model ready");
  return { processor, vision };
}

function normalize(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * scale;
  return out;
}

function cosine(left, right) {
  let score = 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) score += left[i] * right[i];
  return score;
}

async function embed(image) {
  const { processor, vision } = await loadModel();
  const inputs = await processor(image);
  const { image_embeds: embeds } = await vision(inputs);
  return normalize(embeds.data);
}

async function imageFromDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("örnek resim okunamadı");
  const type = match[1] || "application/octet-stream";
  const bytes = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");
  return RawImage.fromBlob(new Blob([bytes], { type }));
}

async function vectorForUrl(url) {
  const cached = byUrl.get(url);
  if (cached) return cached;
  const image = await RawImage.read(url);
  const vector = await embed(image);
  byUrl.set(url, vector);
  if (byUrl.size > 2000) byUrl.delete(byUrl.keys().next().value);
  return vector;
}

export async function similarScores(sampleDataUrl, urls) {
  const key = crypto.createHash("sha256").update(sampleDataUrl).digest("hex");
  if (key !== sampleKey || !sampleVector) {
    sampleVector = await embed(await imageFromDataUrl(sampleDataUrl));
    sampleKey = key;
  }
  const scores = [];
  for (const url of urls) {
    try {
      const score = cosine(sampleVector, await vectorForUrl(url));
      scores.push(Math.round(score * 1000) / 1000);
    } catch (error) {
      console.log(`photo image ${error.message}`);
      scores.push(null);
    }
  }
  return { urls, scores, threshold: SIMILAR_THRESHOLD };
}