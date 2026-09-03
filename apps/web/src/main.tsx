import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackWidget } from "@feedback-kit/react";
import "@feedback-kit/react/styles.css";
import { App } from "./App";
import { TopLayerProvider } from "./top-layer";
import "./styles.css";
import "./desktop-switch.css";
import "./organization-lanes.css";
import "./organization-views.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TopLayerProvider>
      <App />
      {import.meta.env.DEV ? (
        <FeedbackWidget
        accentColor="#70867d"
        defaultScreenshot={false}
        endpoint="/v1/feedback"
        getState={() => ({
          route: `${window.location.pathname}${window.location.search}`,
          theme: document.documentElement.dataset.theme ?? null,
          textSize: document.documentElement.dataset.readerSize ?? null,
          density: document.documentElement.dataset.readerDensity ?? null,
          motion: document.documentElement.dataset.motion ?? null,
        })}
        metadata={{ product: "orca", capture: "local-development" }}
        project={{
          id: "orca",
          name: "Orca",
          version: "local",
          environment: import.meta.env.MODE,
        }}
        />
      ) : null}
    </TopLayerProvider>
  </StrictMode>,
);
