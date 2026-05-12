import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

document.documentElement.classList.add("dark");

window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.message?.includes("Missing or insufficient permissions") ||
      e.reason?.code === "permission-denied") {
    e.preventDefault();
  }
});

window.addEventListener("error", (e) => {
  if (e.message?.includes("Missing or insufficient permissions") ||
      e.message?.includes("permission-denied")) {
    e.preventDefault();
  }
});

createRoot(document.getElementById("root")!).render(<App />);
