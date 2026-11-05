import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { startTheme } from "./theme";

startTheme();
createRoot(document.getElementById("root")!).render(<App />);
