import { createRoot } from "react-dom/client";
import { Toaster as Sonner } from "@/components/ui/sonner";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <Sonner />
  </>,
);
