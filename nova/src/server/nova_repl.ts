import repl from "repl";

export class NovaRepl {
    repl?: repl.REPLServer;
    private prompt = "nova> ";

    constructor() {
        if (Boolean(process.stdin.isTTY) && process.env.NODE_ENV !== 'production') {
            this.repl = repl.start(this.prompt);
        }
    }
}
