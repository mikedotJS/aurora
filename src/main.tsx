import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/tokens.css";
import "./styles/global.css";
import App from "./App";

// No StrictMode: it double-invokes mount effects in dev, which would spawn two
// PTYs per pane.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
