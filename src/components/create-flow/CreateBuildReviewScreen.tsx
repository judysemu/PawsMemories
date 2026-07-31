import React, { useEffect, useState } from "react";
import { Screen } from "../../types";
import { useCreateFlow } from "./CreateFlowContext";
import { ChevronLeft, CheckCircle2, AlertTriangle, RefreshCw, ZoomIn, Info, ShieldCheck, Download, Sparkles } from "lucide-react";
import { getModelBuildDetail, acceptModelBuild } from "../../api";
import Model3DViewer from "./Model3DViewer";
import FriendlyError from "../FriendlyError";

interface CreateBuildReviewScreenProps {
  onNavigate: (screen: Screen) => void;
}

export default function CreateBuildReviewScreen({ onNavigate }: CreateBuildReviewScreenProps) {
  const { state, setState, resetState } = useCreateFlow();
  const [jobDetail, setJobDetail] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<"renders" | "3d" | "metrics">("renders");
  const [zoomedImage, setZoomedImage] = useState<{ label: string; url: string } | null>(null);

  const jobUuid = state.activeJobUuid;

  useEffect(() => {
    if (!jobUuid) return;
    setIsLoading(true);
    getModelBuildDetail(jobUuid)
      .then((res) => {
        const detail = res.data;
        setJobDetail(detail);
        setState((s) => ({ ...s, buildJobDetail: detail }));
      })
      .catch((err) => setError(err.message || "Failed to load model build details."))
      .finally(() => setIsLoading(false));
  }, [jobUuid]);

  const validatedGlbArtifact = jobDetail?.artifacts?.find((a: any) => a.role === "validated_glb");
  const renderArtifacts = jobDetail?.artifacts?.filter((a: any) => a.role.startsWith("render_")) || [];
  const report = jobDetail?.report;
  const metrics = report?.metrics || {};
  const advisoryLikeness = metrics.advisoryLikeness;

  const renderLabels: Record<string, string> = {
    render_front: "Front Render",
    render_rear: "Rear Render",
    render_left: "Left Profile",
    render_right: "Right Profile",
    render_three_quarter: "3/4 Perspective",
  };

  const handleAccept = async () => {
    if (!jobUuid || !validatedGlbArtifact || !report) return;
    setIsAccepting(true);
    setError(null);
    try {
      await acceptModelBuild(
        jobUuid,
        validatedGlbArtifact.sha256,
        report.metricsHash
      );
      resetState();
      onNavigate(Screen.FURBIN);
    } catch (err: any) {
      setError(err.message || "Failed to accept model build.");
      setIsAccepting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full max-w-4xl mx-auto px-4 py-16 text-center">
        <RefreshCw className="animate-spin text-primary mx-auto mb-4" size={48} />
        <h3 className="text-xl font-bold text-on-surface">Loading 3D Model Review...</h3>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 animate-in fade-in zoom-in duration-500 overflow-x-hidden">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <button
          onClick={() => onNavigate(Screen.CREATE_BUILD_PROGRESS)}
          className="flex items-center gap-1 text-on-surface-variant hover:text-primary font-medium"
        >
          <ChevronLeft size={20} /> Back to Progress
        </button>
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 uppercase tracking-wider flex items-center gap-1">
          <ShieldCheck size={14} /> Validated GLB Ready
        </span>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-3xl font-black text-on-surface mb-2">Verified 3D Model Review</h1>
        <p className="text-on-surface-variant text-lg">
          Review standard renders, post-build geometry metrics, and advisory likeness before acceptance.
        </p>
      </div>

      {/* Main Review Panel */}
      <div className="glass-panel p-6 rounded-3xl relative overflow-hidden flex flex-col gap-6">
        {/* Navigation Tabs */}
        <div className="flex gap-2 rounded-2xl bg-surface-variant/40 p-1.5" role="tablist">
          <button
            role="tab"
            aria-selected={selectedTab === "renders"}
            onClick={() => setSelectedTab("renders")}
            className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold transition-all ${
              selectedTab === "renders"
                ? "bg-primary text-on-primary shadow-md"
                : "text-on-surface-variant hover:text-primary"
            }`}
          >
            Standard Renders ({renderArtifacts.length})
          </button>
          <button
            role="tab"
            aria-selected={selectedTab === "3d"}
            onClick={() => setSelectedTab("3d")}
            className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold transition-all ${
              selectedTab === "3d"
                ? "bg-primary text-on-primary shadow-md"
                : "text-on-surface-variant hover:text-primary"
            }`}
          >
            3D GLB Viewer
          </button>
          <button
            role="tab"
            aria-selected={selectedTab === "metrics"}
            onClick={() => setSelectedTab("metrics")}
            className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold transition-all ${
              selectedTab === "metrics"
                ? "bg-primary text-on-primary shadow-md"
                : "text-on-surface-variant hover:text-primary"
            }`}
          >
            Validation Metrics
          </button>
        </div>

        {/* Tab 1: Standard Renders */}
        {selectedTab === "renders" && (
          <div className="flex flex-col gap-4">
            {renderArtifacts.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                {renderArtifacts.map((art: any) => (
                  <div
                    key={art.role}
                    className="relative group rounded-2xl overflow-hidden shadow-md border-2 border-surface-variant aspect-square bg-black/20 flex flex-col justify-between p-2"
                  >
                    {art.signedUrl ? (
                      <img
                        src={art.signedUrl}
                        alt={renderLabels[art.role] || art.role}
                        className="w-full h-full object-contain cursor-pointer transition-transform group-hover:scale-105"
                        onClick={() => setZoomedImage({ label: renderLabels[art.role] || art.role, url: art.signedUrl })}
                      />
                    ) : (
                      <div className="flex items-center justify-center h-full text-xs text-on-surface-variant">
                        No signed URL
                      </div>
                    )}
                    <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-md px-2 py-0.5 rounded-full text-[10px] font-bold text-white uppercase tracking-wider">
                      {renderLabels[art.role] || art.role}
                    </div>
                    {art.signedUrl && (
                      <button
                        onClick={() => setZoomedImage({ label: renderLabels[art.role] || art.role, url: art.signedUrl })}
                        className="absolute bottom-2 right-2 p-1.5 bg-black/60 hover:bg-black text-white rounded-full"
                        aria-label={`Zoom ${renderLabels[art.role]}`}
                      >
                        <ZoomIn size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center bg-surface-variant/20 rounded-2xl border border-outline-variant/30 text-sm text-on-surface-variant">
                Standard review renders require the Blender worker container boundary.
              </div>
            )}
          </div>
        )}

        {/* Tab 2: 3D GLB Viewer */}
        {selectedTab === "3d" && (
          <div className="flex flex-col gap-4">
            {validatedGlbArtifact?.signedUrl ? (
              <div className="w-full flex flex-col gap-4">
                <Model3DViewer signedUrl={validatedGlbArtifact.signedUrl} />
                <div className="flex items-center justify-between p-4 bg-surface rounded-2xl border border-outline-variant">
                  <div>
                    <h4 className="font-bold text-on-surface text-xs">Validated GLB Binary Asset</h4>
                    <p className="text-[11px] text-on-surface-variant">
                      SHA-256: <code className="font-mono">{validatedGlbArtifact.sha256.slice(0, 16)}...</code> ({(validatedGlbArtifact.sizeBytes / (1024 * 1024)).toFixed(2)} MB)
                    </p>
                  </div>
                  <a
                    href={validatedGlbArtifact.signedUrl}
                    download="model.glb"
                    target="_blank"
                    rel="noreferrer"
                    className="px-4 py-2 rounded-xl font-bold bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-colors flex items-center gap-1.5 text-xs"
                  >
                    <Download size={14} /> Download GLB
                  </a>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center bg-surface-variant/20 rounded-2xl border border-outline-variant/30 text-sm text-on-surface-variant">
                No signed GLB URL available for 3D preview.
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Validation Metrics */}
        {selectedTab === "metrics" && (
          <div className="flex flex-col gap-4">
            <div className="p-4 rounded-2xl bg-surface-variant/30 border border-outline-variant/40 space-y-3 text-xs">
              <div className="flex justify-between items-center">
                <span className="font-bold text-on-surface">Validator Version</span>
                <span className="font-mono text-on-surface-variant">{report?.validatorVersions || "v1"}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="font-bold text-on-surface">Metrics Hash</span>
                <span className="font-mono text-on-surface-variant">{report?.metricsHash?.slice(0, 16)}...</span>
              </div>
              {metrics.triangles !== undefined && (
                <div className="flex justify-between items-center">
                  <span className="font-bold text-on-surface">Triangle Count</span>
                  <span className="font-mono text-on-surface-variant">{metrics.triangles}</span>
                </div>
              )}
              {metrics.vertices !== undefined && (
                <div className="flex justify-between items-center">
                  <span className="font-bold text-on-surface">Vertex Count</span>
                  <span className="font-mono text-on-surface-variant">{metrics.vertices}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Advisory Likeness Comparison Card */}
        {advisoryLikeness && (
          <div className="p-5 rounded-2xl bg-surface-variant/30 border border-outline-variant/40 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Info className="text-primary" size={20} />
                <h4 className="font-bold text-on-surface">{advisoryLikeness.label}</h4>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-primary/20 text-primary">
                Advisory Heuristic
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-surface/50 flex flex-col gap-1">
                <span className="text-on-surface-variant">Palette Distance (CIEDE2000)</span>
                <span className="font-mono font-bold text-sm text-on-surface">
                  {advisoryLikeness.paletteDistance !== null ? advisoryLikeness.paletteDistance : "N/A"}
                </span>
              </div>
              <div className="p-3 rounded-xl bg-surface/50 flex flex-col gap-1">
                <span className="text-on-surface-variant">Advisory Likeness Score</span>
                <span className="font-mono font-bold text-sm text-primary">
                  {advisoryLikeness.overallScore !== null ? `${(advisoryLikeness.overallScore * 100).toFixed(0)}%` : "N/A"}
                </span>
              </div>
            </div>

            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] leading-snug text-on-surface">
              <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <p>{advisoryLikeness.limitations}</p>
            </div>
          </div>
        )}

        {error && <FriendlyError message={error} action="Please try again, or come back in a moment." />}

        {/* Hash-Bound Acceptance Button */}
        <div className="flex flex-col gap-2 pt-4 border-t border-outline-variant/30">
          <button
            onClick={handleAccept}
            disabled={isAccepting || !validatedGlbArtifact || !report}
            className={`w-full py-4 px-6 rounded-2xl font-black text-on-primary bg-primary shadow-lg shadow-primary/25 hover:scale-[1.01] transition-transform flex items-center justify-center gap-2 text-base ${
              isAccepting ? "opacity-80 pointer-events-none" : ""
            }`}
          >
            {isAccepting ? (
              <><RefreshCw className="animate-spin" size={20} /> Accepting Build...</>
            ) : (
              <><CheckCircle2 size={20} /> Accept Verified 3D Model</>
            )}
          </button>
          <div className="text-center text-[11px] text-on-surface-variant space-y-0.5">
            <p>Explicit Hash-Bound Acceptance:</p>
            <p className="font-mono text-[10px]">
              Artifact: {validatedGlbArtifact?.sha256?.slice(0, 16)}... | Report: {report?.metricsHash?.slice(0, 16)}...
            </p>
          </div>
        </div>
      </div>

      {/* Zoom Image Modal */}
      {zoomedImage && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative max-w-3xl w-full bg-surface p-6 rounded-3xl flex flex-col items-center gap-4">
            <button
              onClick={() => setZoomedImage(null)}
              className="absolute top-4 right-4 p-2 rounded-full bg-surface-variant hover:bg-surface-variant/80 text-on-surface"
              aria-label="Close modal"
            >
              ✕
            </button>
            <h3 className="text-lg font-bold text-on-surface">{zoomedImage.label}</h3>
            <img
              src={zoomedImage.url}
              alt={zoomedImage.label}
              className="max-h-[70vh] object-contain rounded-2xl border border-outline-variant"
            />
          </div>
        </div>
      )}
    </div>
  );
}
