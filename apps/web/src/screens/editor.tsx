import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { StreamMarkdown } from "@anvia/react-ui/stream";
import {
  applyCommand,
  centerCamera,
  composite,
  createHistory,
  fitZoom,
  frameToBuffer,
  pushHistory,
  redoHistory,
  stepZoom,
  undoHistory,
  zoomAt,
  type Camera,
  type FrameBuffer,
  type History,
} from "@pixelaition/pixel";
import { Button, ModelSelect, TextInput } from "../components/ui.js";
import { api } from "../lib/api.js";

type LayerDto = { id: string; name: string; visible: boolean; pixels: string };
type FrameDto = { id: string; name: string; index: number; layers: LayerDto[] };
type AssetDto = {
  id: string;
  name: string;
  width: number;
  height: number;
  palette: string[];
  frames: FrameDto[];
};

type Activity = { id: string; text: string };

const tools = ["pencil", "eraser", "fill", "pan"] as const;
type Tool = (typeof tools)[number];

export function EditorScreen() {
  const { assetId } = useParams({ from: "/projects/$projectId/assets/$assetId" });
  const asset = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => api<AssetDto>(`/api/assets/${assetId}`),
  });
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: () =>
      api<{ lastModelId: string | null; lastReasoningEffort: string | null }>(
        "/api/preferences",
      ),
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api<{ models: Array<{ id: string }> }>("/api/models"),
  });
  const [frameId, setFrameId] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [tool, setTool] = useState<Tool>("pencil");
  const [color, setColor] = useState(1);
  const [camera, setCamera] = useState<Camera>({ x: 40, y: 40, zoom: 16 });
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("medium");
  const [activity, setActivity] = useState<Activity[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const space = useRef(false);
  const dragging = useRef<{ x: number; y: number; camera: Camera } | null>(null);

  useEffect(() => {
    if (!asset.data || history) return;
    const frame = asset.data.frames[0];
    if (!frame) return;
    setFrameId(frame.id);
    setHistory(
      createHistory(
        frameToBuffer(frame, asset.data.width, asset.data.height, asset.data.palette),
      ),
    );
  }, [asset.data, history]);

  useEffect(() => {
    if (preferences.data?.lastModelId) setModelId(preferences.data.lastModelId);
    if (preferences.data?.lastReasoningEffort)
      setEffort(preferences.data.lastReasoningEffort);
  }, [preferences.data]);

  useEffect(() => {
    const view = viewRef.current;
    const buffer = history?.present;
    if (!view || !buffer) return;
    const context = view.getContext("2d");
    if (!context) return;
    const draw = () => {
      const rect = view.getBoundingClientRect();
      view.width = Math.floor(rect.width * devicePixelRatio);
      view.height = Math.floor(rect.height * devicePixelRatio);
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      context.imageSmoothingEnabled = false;
      context.fillStyle = "#1c1915";
      context.fillRect(0, 0, rect.width, rect.height);
      const indexes = composite(buffer);
      for (let y = 0; y < buffer.height; y += 1) {
        for (let x = 0; x < buffer.width; x += 1) {
          const index = indexes[y * buffer.width + x] ?? 0;
          context.fillStyle =
            index === 0 ? "rgba(244,239,228,0.04)" : (buffer.palette[index] ?? "#000");
          context.fillRect(
            camera.x + x * camera.zoom,
            camera.y + y * camera.zoom,
            camera.zoom,
            camera.zoom,
          );
        }
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(view);
    return () => observer.disconnect();
  }, [history, camera]);

  function cell(event: React.PointerEvent<HTMLCanvasElement>) {
    const buffer = history?.present;
    const view = viewRef.current;
    if (!buffer || !view) return null;
    const rect = view.getBoundingClientRect();
    return {
      x: Math.floor((event.clientX - rect.left - camera.x) / camera.zoom),
      y: Math.floor((event.clientY - rect.top - camera.y) / camera.zoom),
    };
  }

  function edit(command: Parameters<typeof applyCommand>[1]) {
    if (!history) return;
    const result = applyCommand(history.present, command);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setHistory(pushHistory(history, result.buffer));
  }

  const save = useMutation({
    mutationFn: async (buffer: FrameBuffer) => {
      if (!frameId) return;
      await api(`/api/assets/${assetId}/frames/${frameId}`, {
        method: "PUT",
        body: JSON.stringify({
          layers: buffer.layers.map((layer) => ({
            id: layer.id,
            name: layer.name,
            visible: layer.visible,
            pixels: bytesToBase64(layer.pixels),
          })),
        }),
      });
    },
  });

  useEffect(() => {
    if (!history) return;
    const timer = window.setTimeout(() => save.mutate(history.present), 500);
    return () => window.clearTimeout(timer);
  }, [history?.present]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code === "Space") space.current = event.type === "keydown";
      if (event.key === "b") setTool("pencil");
      if (event.key === "e") setTool("eraser");
      if (event.key === "g") setTool("fill");
      if (event.key === "h") setTool("pan");
      if ((event.metaKey || event.ctrlKey) && event.key === "z") {
        setHistory((current) =>
          current
            ? event.shiftKey
              ? redoHistory(current)
              : undoHistory(current)
            : current,
        );
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "0" &&
        viewRef.current &&
        history
      ) {
        const rect = viewRef.current.getBoundingClientRect();
        const zoom = fitZoom(
          rect.width,
          rect.height,
          history.present.width,
          history.present.height,
        );
        setCamera(
          centerCamera(
            rect.width,
            rect.height,
            history.present.width,
            history.present.height,
            zoom,
          ),
        );
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [history]);

  async function generate() {
    if (!frameId) return;
    setError(null);
    setMessage("");
    await api("/api/preferences", {
      method: "PATCH",
      body: JSON.stringify({ lastModelId: modelId, lastReasoningEffort: effort }),
    });
    try {
      const started = await api<{ runId: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          assetId,
          frameId,
          prompt,
          modelId,
          reasoningEffort: effort,
        }),
      });
      const source = new EventSource(`/api/runs/${started.runId}/stream`);
      source.onmessage = (event) => {
        const body = JSON.parse(event.data) as {
          type: string;
          data: { layers?: LayerDto[]; status?: string; delta?: string };
        };
        if (body.type === "canvas-stroke" && body.data.layers && history) {
          const next = structuredClone(history.present);
          next.layers = body.data.layers.map((layer) => ({
            ...layer,
            pixels: base64ToBytes(layer.pixels),
          }));
          setHistory(pushHistory(history, next));
        }
        if (body.type === "model_delta") {
          const text =
            typeof body.data === "object" && body.data && "event" in body.data
              ? JSON.stringify(body.data)
              : body.type;
          setActivity((current) => [
            ...current.slice(-6),
            { id: crypto.randomUUID(), text },
          ]);
        } else if (body.type !== "canvas-stroke") {
          setActivity((current) => [
            ...current.slice(-6),
            { id: crypto.randomUUID(), text: body.type.replaceAll("_", " ") },
          ]);
        }
        if (body.type === "done") {
          setMessage(
            body.data.status === "completed"
              ? "The frame is ready."
              : `Run ${body.data.status ?? "finished"}.`,
          );
          source.close();
        }
      };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Generation failed.");
    }
  }

  const buffer = history?.present;
  const layerId = buffer?.layers[0]?.id ?? "";
  const modelOptions =
    models.data?.models.map((model) => model.id) ??
    (modelId ? [modelId] : ["Set OPENAI_MODEL"]);

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] bg-paper">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <a href="/projects" className="font-mono text-xs tracking-[0.18em] text-accent">
          PIXELAITION
        </a>
        <p className="text-sm text-muted">{asset.data?.name ?? "Loading asset"}</p>
      </header>
      <div className="grid min-h-0 lg:grid-cols-[240px_1fr_260px]">
        <aside className="hidden border-r border-line p-3 lg:block">
          <p className="text-xs text-muted">Frames</p>
          <div className="mt-2 grid gap-1">
            {asset.data?.frames.map((frame) => (
              <button
                key={frame.id}
                className={`rounded px-2 py-1 text-left text-sm ${frame.id === frameId ? "bg-panel text-accent" : ""}`}
                onClick={() => switchFrame(frame)}
              >
                {frame.name}
              </button>
            ))}
          </div>
        </aside>
        <canvas
          ref={viewRef}
          className="h-full w-full touch-none"
          onWheel={(event) => {
            event.preventDefault();
            if (!buffer) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const next = stepZoom(camera.zoom, event.deltaY < 0 ? 1 : -1);
            setCamera(
              zoomAt(camera, event.clientX - rect.left, event.clientY - rect.top, next),
            );
          }}
          onPointerDown={(event) => {
            if (tool === "pan" || space.current) {
              dragging.current = { x: event.clientX, y: event.clientY, camera };
              return;
            }
            const point = cell(event);
            if (!point) return;
            if (tool === "fill") edit({ type: "fill", layerId, ...point, color });
            else if (tool === "eraser") edit({ type: "erase", layerId, points: [point] });
            else edit({ type: "paint", layerId, points: [{ ...point, color }] });
          }}
          onPointerMove={(event) => {
            if (dragging.current) {
              setCamera({
                ...dragging.current.camera,
                x: dragging.current.camera.x + event.clientX - dragging.current.x,
                y: dragging.current.camera.y + event.clientY - dragging.current.y,
              });
              return;
            }
            if (event.buttons !== 1 || tool === "fill") return;
            const point = cell(event);
            if (!point) return;
            if (tool === "eraser") edit({ type: "erase", layerId, points: [point] });
            else edit({ type: "paint", layerId, points: [{ ...point, color }] });
          }}
          onPointerUp={() => {
            dragging.current = null;
          }}
        />
        <aside className="hidden border-l border-line p-3 lg:block">
          <p className="text-xs text-muted">Palette</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {buffer?.palette.map((swatch, index) => (
              <button
                key={swatch + index}
                aria-label={`Color ${index}`}
                className={`h-7 w-7 rounded border ${color === index ? "border-accent" : "border-line"}`}
                style={{ background: index === 0 ? "transparent" : swatch }}
                onClick={() => setColor(index)}
              />
            ))}
          </div>
          <p className="mt-4 font-mono text-xs text-muted">
            {Math.round(camera.zoom * 100)}%
          </p>
        </aside>
      </div>
      <footer className="border-t border-line p-3">
        <div className="mb-2 flex flex-wrap gap-2">
          {tools.map((item) => (
            <Button
              key={item}
              tone={tool === item ? "solid" : "ghost"}
              onClick={() => setTool(item)}
            >
              {item}
            </Button>
          ))}
        </div>
        {activity.length > 0 ? (
          <p className="mb-2 font-mono text-xs text-muted">{activity.at(-1)?.text}</p>
        ) : null}
        {message ? <StreamMarkdown content={message} /> : null}
        {error ? <p className="mb-2 text-sm text-erase">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            className="min-w-64 flex-1"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the pixel asset or a new state"
          />
          <ModelSelect
            label="Model"
            value={modelId || modelOptions[0] || ""}
            options={modelOptions}
            onChange={setModelId}
          />
          <ModelSelect
            label="Reasoning effort"
            value={effort}
            options={["none", "low", "medium", "high"]}
            onChange={setEffort}
          />
          <Button onClick={() => void generate()} disabled={!prompt.trim() || !modelId}>
            Generate
          </Button>
        </div>
      </footer>
    </div>
  );

  function switchFrame(frame: FrameDto) {
    if (!asset.data) return;
    setFrameId(frame.id);
    setHistory(
      createHistory(
        frameToBuffer(frame, asset.data.width, asset.data.height, asset.data.palette),
      ),
    );
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}
