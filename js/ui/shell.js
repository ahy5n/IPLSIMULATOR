// Masthead and footer shared by every screen.
export function masthead(right = '') {
  return `<header class="masthead">
    <a class="brand" href="#" data-nav="home" aria-label="IPL Auction Simulator home">
      <span class="brand-name">Auction Simulator</span><span class="brand-sub">IPL · PSL · SA20 · The Hundred</span>
    </a>${right}</header>`;
}

export function footer() {
  return `<footer class="footer">
    <span>Fan-made simulator. Not affiliated with the IPL, PSL, SA20, The Hundred, their boards or any franchise.</span>
    <span>Player list, reserve prices and sets: BCCI auction list (9 Dec 2025). Retentions, purses and real prices: IPL announcements via Wikipedia. PSL, SA20 and Hundred squads, fees and coaches: Wikipedia (Oct 2026). Ratings are the simulator's own estimates.</span>
  </footer>`;
}
