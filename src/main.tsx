import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LocalSessionGate } from "./components/LocalSessionGate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocalSessionGate><App /></LocalSessionGate>
  </StrictMode>,
);
