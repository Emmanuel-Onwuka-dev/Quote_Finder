import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { CreatorPage } from "./components/CreatorPage";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}
const isCreatorPage = window.location.pathname.startsWith("/creator");
createRoot(root).render(
  <StrictMode>{isCreatorPage ? <CreatorPage /> : <App />}</StrictMode>,
);
