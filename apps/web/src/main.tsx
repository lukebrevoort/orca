import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TopLayerProvider } from "./top-layer";
import "./styles.css";
import "./desktop-switch.css";
import "./organization-lanes.css";
import "./organization-views.css";

// Vite removes this entire import (including widget CSS) in production.
const DevelopmentFeedback = import.meta.env.DEV
  ? lazy(() => import("./development-feedback"))
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TopLayerProvider>
      <App />
      {DevelopmentFeedback ? (
        <Suspense fallback={null}>
          <DevelopmentFeedback />
        </Suspense>
      ) : null}
    </TopLayerProvider>
  </StrictMode>,
);
