#!/usr/bin/env python3
"""Build the career-mode world: one player database shared by the IPL, PSL, SA20 and The Hundred,
every team's current squad and fees, and every head coach.

Sources (cached in tools/raw/leagues/):
  - Wikipedia pages for the latest season of each league (squads, fees, coaches)
  - Wikipedia infoboxes for every player not already in the IPL data (country, birth date, styles,
    T20 career numbers), turned into ratings with a fit against the players we have curated ratings for.

Usage:
  python3 tools/build_leagues.py            # build from the cached pages
  python3 tools/build_leagues.py --fetch    # re-download pages and infoboxes first
"""
import json, math, os, re, sys, time, urllib.parse, urllib.request, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'tools', 'raw', 'leagues')
OUT = os.path.join(ROOT, 'data', 'career')
TODAY = (2026, 10, 17)
UA = 'Mozilla/5.0 ipl-auction-sim data builder (local)'

PAGES = {
    'psl': '2026 Pakistan Super League',
    'psl-signings': '2026 Pakistan Super League personnel signings and auction',
    'sa20': '2027 SA20',
    'sa20-signings': 'List of 2027 SA20 auctions and personnel signings',
    'hundred': '2026 The Hundred season',
}

# ---------- teams ----------
# id, name, wiki name(s), colours, home, head coach
TEAMS = {
    'psl': [
        ('HK', 'Hyderabad Kingsmen', ['Hyderabad Kingsmen', 'Kingsmen Hyderabad'], '#0F6E5B', '#E8C547', 'Niaz Stadium, Hyderabad', 'Jason Gillespie'),
        ('IU', 'Islamabad United', ['Islamabad United'], '#D7262E', '#1F1F1F', 'Rawalpindi Cricket Stadium', 'Luke Ronchi'),
        ('KRK', 'Karachi Kings', ['Karachi Kings'], '#1B5FAA', '#E5242B', 'National Stadium, Karachi', 'Ravi Bopara'),
        ('LQ', 'Lahore Qalandars', ['Lahore Qalandars'], '#00A14B', '#E31E26', 'Gaddafi Stadium, Lahore', 'Russell Domingo'),
        ('MS', 'Multan Sultans', ['Multan Sultans', 'Sialkot Stallionz'], '#0B8A43', '#F2A900', 'Multan Cricket Stadium', 'Tim Paine'),
        ('PZ', 'Peshawar Zalmi', ['Peshawar Zalmi'], '#F5B800', '#111111', 'Arbab Niaz Stadium, Peshawar', 'Ottis Gibson'),
        ('QG', 'Quetta Gladiators', ['Quetta Gladiators'], '#6B2C91', '#F2C200', 'Bugti Stadium, Quetta', 'Moin Khan'),
        ('RWP', 'Rawalpindiz', ['Rawalpindiz', 'Pindiz', 'Rawalpindi Pindiz'], '#C8102E', '#0A2240', 'Pindi Cricket Stadium', 'Justin Kemp'),
    ],
    'sa20': [
        ('DSG', "Durban's Super Giants", ["Durban's Super Giants"], '#147FD9', '#E2B33C', 'Kingsmead, Durban', 'Lance Klusener'),
        ('JSK', 'Joburg Super Kings', ['Joburg Super Kings'], '#F5D000', '#00733C', 'Wanderers, Johannesburg', 'Albie Morkel'),
        ('MICT', 'MI Cape Town', ['MI Cape Town'], '#004BA0', '#D1AB3E', 'Newlands, Cape Town', 'Robin Peterson'),
        ('PR', 'Paarl Royals', ['Paarl Royals'], '#FF348A', '#1C2C5B', 'Boland Park, Paarl', 'Trevor Penney'),
        ('PC', 'Pretoria Capitals', ['Pretoria Capitals'], '#459FE7', '#C8102E', 'Centurion Park', 'Sourav Ganguly'),
        ('SEC', 'Sunrisers Eastern Cape', ['Sunrisers Eastern Cape'], '#EB5604', '#111111', "St George's Park, Gqeberha", 'Adrian Birrell'),
    ],
    'hundred': [
        ('BPH', 'Birmingham Phoenix', ['Birmingham Phoenix'], '#E35205', '#1B1B3A', 'Edgbaston, Birmingham', 'Shane Bond'),
        ('LS', 'London Spirit', ['London Spirit'], '#0A2D6E', '#C9A227', "Lord's, London", 'Andy Flower'),
        ('MSG', 'Manchester Super Giants', ['Manchester Super Giants', 'Manchester Originals'], '#0057B8', '#E2B33C', 'Old Trafford, Manchester', 'Justin Langer'),
        ('MIL', 'MI London', ['MI London', 'Oval Invincibles'], '#004BA0', '#D1AB3E', 'The Oval, London', 'Kieron Pollard'),
        ('SB', 'Southern Brave', ['Southern Brave'], '#00A3AD', '#6D2077', 'Rose Bowl, Southampton', 'Hemang Badani'),
        ('SRL', 'Sunrisers Leeds', ['Sunrisers Leeds', 'Northern Superchargers'], '#F26522', '#111111', 'Headingley, Leeds', 'Daniel Vettori'),
        ('TR', 'Trent Rockets', ['Trent Rockets'], '#F4C300', '#1C1C1C', 'Trent Bridge, Nottingham', 'Peter Moores'),
        ('WF', 'Welsh Fire', ['Welsh Fire'], '#B5121B', '#111111', 'Sophia Gardens, Cardiff', 'Mike Hussey'),
    ],
}
IPL_COACHES = {'CSK': 'Stephen Fleming', 'KKR': 'Abhishek Nayar', 'PBKS': 'Ricky Ponting', 'RR': 'Kumar Sangakkara',
               'RCB': 'Andy Flower', 'DC': 'Hemang Badani', 'GT': 'Ashish Nehra', 'LSG': 'Justin Langer',
               'MI': 'Mahela Jayawardene', 'SRH': 'Daniel Vettori'}
# Reputation 0-100: titles, years in the job and standing in the game. A judgement call, kept in one place.
COACH_REP = {
    'Stephen Fleming': 90, 'Mahela Jayawardene': 87, 'Ricky Ponting': 84, 'Ashish Nehra': 84, 'Andy Flower': 85,
    'Kumar Sangakkara': 78, 'Daniel Vettori': 77, 'Justin Langer': 77, 'Hemang Badani': 66, 'Abhishek Nayar': 64,
    'Jason Gillespie': 72, 'Luke Ronchi': 67, 'Ravi Bopara': 58, 'Russell Domingo': 69, 'Tim Paine': 57,
    'Ottis Gibson': 70, 'Moin Khan': 61, 'Justin Kemp': 55, 'Lance Klusener': 67, 'Albie Morkel': 58,
    'Robin Peterson': 66, 'Trevor Penney': 63, 'Sourav Ganguly': 70, 'Adrian Birrell': 73, 'Shane Bond': 72,
    'Kieron Pollard': 62, 'Peter Moores': 68, 'Mike Hussey': 68,
}
# Well-known coaches without a franchise head-coach job in these four leagues, so the job market has
# candidates. Availability is the game's assumption, not a claim about their plans.
FREE_COACHES = {'Tom Moody': 80, 'Trevor Bayliss': 79, 'Mickey Arthur': 74, 'Gary Kirsten': 81, 'Mark Boucher': 70,
                'Simon Katich': 68, 'Graham Ford': 67, 'Darren Lehmann': 71, 'Aaqib Javed': 63, 'Faf du Plessis': 60}
COACH_COUNTRY = {
    'Stephen Fleming': 'New Zealand', 'Mahela Jayawardene': 'Sri Lanka', 'Ricky Ponting': 'Australia', 'Ashish Nehra': 'India',
    'Andy Flower': 'Zimbabwe', 'Kumar Sangakkara': 'Sri Lanka', 'Daniel Vettori': 'New Zealand', 'Justin Langer': 'Australia',
    'Hemang Badani': 'India', 'Abhishek Nayar': 'India', 'Jason Gillespie': 'Australia', 'Luke Ronchi': 'New Zealand',
    'Ravi Bopara': 'England', 'Russell Domingo': 'South Africa', 'Tim Paine': 'Australia', 'Ottis Gibson': 'West Indies',
    'Moin Khan': 'Pakistan', 'Justin Kemp': 'South Africa', 'Lance Klusener': 'South Africa', 'Albie Morkel': 'South Africa',
    'Robin Peterson': 'South Africa', 'Trevor Penney': 'Zimbabwe', 'Sourav Ganguly': 'India', 'Adrian Birrell': 'South Africa',
    'Shane Bond': 'New Zealand', 'Kieron Pollard': 'West Indies', 'Peter Moores': 'England', 'Mike Hussey': 'Australia',
    'Tom Moody': 'Australia', 'Trevor Bayliss': 'Australia', 'Mickey Arthur': 'South Africa', 'Gary Kirsten': 'South Africa',
    'Mark Boucher': 'South Africa', 'Simon Katich': 'Australia', 'Graham Ford': 'South Africa', 'Darren Lehmann': 'Australia',
    'Aaqib Javed': 'Pakistan', 'Faf du Plessis': 'South Africa',
}

FLAG = {'AUS': 'Australia', 'ENG': 'England', 'NZ': 'New Zealand', 'SA': 'South Africa', 'RSA': 'South Africa', 'WI': 'West Indies',
        'WIN': 'West Indies', 'SL': 'Sri Lanka', 'AFG': 'Afghanistan', 'BAN': 'Bangladesh', 'IND': 'India', 'PAK': 'Pakistan',
        'ZIM': 'Zimbabwe', 'IRE': 'Ireland', 'SCO': 'Scotland', 'NED': 'Netherlands', 'NEP': 'Nepal', 'USA': 'United States',
        'UAE': 'United Arab Emirates', 'NAM': 'Namibia', 'CAN': 'Canada', 'OMA': 'Oman', 'HK': 'Hong Kong',
        'JER': 'Jersey', 'GUE': 'Guernsey', 'WAL': 'Wales', 'ITA': 'Italy', 'GER': 'Germany'}
# Money per league, in each league's own unit: IPL ₹ lakh, PSL PKR lakh, SA20 rand thousands, Hundred £ thousands.
# cap = the purse / salary cap for the latest season; min = the lowest fee a squad player is paid.
MONEY = {'psl': dict(cap=5050, min=60), 'sa20': dict(cap=41000, min=200), 'hundred': dict(cap=2050, min=30)}
HOME = {'ipl': 'India', 'psl': 'Pakistan', 'sa20': 'South Africa', 'hundred': 'England'}


def http(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('utf-8')


def raw_page(key):
    return open(os.path.join(RAW, PAGES[key].replace(' ', '_').replace("'", '_') + '.wiki')).read()


def fetch_pages():
    for key, title in PAGES.items():
        url = 'https://en.wikipedia.org/w/index.php?title=' + urllib.parse.quote(title.replace(' ', '_')) + '&action=raw'
        open(os.path.join(RAW, title.replace(' ', '_').replace("'", '_') + '.wiki'), 'w').write(http(url))
        time.sleep(1)


def slug(name):
    s = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    return s


def norm(n):
    return re.sub(r'[^a-z]', '', n.lower())


def strip_refs(s):
    s = re.sub(r'<ref[^>]*/>', '', s)
    s = re.sub(r'<ref[^>]*>.*?</ref>', '', s, flags=re.S)
    return s


LINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")


def parse_entry(line):
    """'* [[Title|Name]] {{cricon|AUS}} (c)' → dict(title, name, flag)."""
    line = strip_refs(line)
    flag = re.search(r'\{\{cricon\|([A-Z]+)', line)
    links = [m for m in LINK.finditer(line) if not re.match(r'(Captain|Wicket|File:)', m.group(1))]
    if links:
        title = links[0].group(1).strip()
        name = (links[0].group(2) or title).strip()
    else:
        name = re.sub(r"\{\{[^}]*\}\}|\(.*?\)|'''|\*", '', line).strip()
        title = None
    name = re.sub(r'\s*\(.*?\)\s*$', '', name).strip()
    return dict(title=title, name=name, flag=FLAG.get(flag.group(1)) if flag else None)


def squad_table(text, start_marker, team_names, end_marker='|}'):
    """Parse a wikitable of squads: one column per team, bullet lists of players."""
    i = text.index(start_marker)
    j = text.index(end_marker, i)
    block = text[i:j]
    # Column headers in order.
    heads = []
    for line in block.split('\n'):
        if line.startswith('!') and not line.startswith('! colspan'):
            for cell in re.split(r'!!', line[1:]):
                m = LINK.search(cell)
                label = (m.group(2) or m.group(1)) if m else cell.strip()
                label = re.sub(r'<[^>]+>', '', label).strip()
                tid = team_names.get(re.sub(r'^\d{4} ', '', label).replace(' season', '').strip())
                if tid:
                    heads.append(tid)
    cols = re.split(r'\n\|\s*valign\s*=\s*"?top"?\s*\|', block)[1:]
    out = {t: [] for t in heads}
    for k, col in enumerate(cols):
        tid = heads[k % len(heads)]
        for line in col.split('\n'):
            if line.strip().startswith('*'):
                e = parse_entry(line)
                if e['name']:
                    out[tid].append(e)
    return out


def team_lookup(league):
    m = {}
    for tid, name, aliases, *_ in TEAMS[league]:
        for a in aliases + [name]:
            m[a] = tid
    return m


PSL_AUCTION = set()
PSL_AUCTION_TEAM = {}


def parse_psl():
    text = raw_page('psl')
    squads = squad_table(text, '{{collapsed top|Squads}}', team_lookup('psl'), '{{collapsed bottom}}')
    # Fees in PKR crore → stored in PKR lakh (1 crore = 100 lakh).
    sig = raw_page('psl-signings')
    fees = {}
    # Retention and direct-signing fees are flat by category; only auction prices say how good a player is.
    auction = sig[sig.index('==Auction=='):sig.index('==Transfer')]
    PSL_AUCTION.clear()
    for row in re.split(r'\n\|-', auction):
        links = [x for x in LINK.finditer(row)]
        if links:
            PSL_AUCTION.add(norm(links[0].group(2) or links[0].group(1)))
            tid = team_lookup('psl').get((links[-1].group(2) or links[-1].group(1)).strip())
            if tid: PSL_AUCTION_TEAM[norm(links[0].group(2) or links[0].group(1))] = tid
    for row in re.split(r'\n\|-', sig):
        cells = [c.strip() for c in re.split(r'\n\||\|\|', row) if c.strip()]
        pk = re.findall(r'\{\{PKR\|([\d.]+) (crore|lakh)\}\}', row)
        m = LINK.search(row)
        if m and pk:
            amt, unit = pk[-1]
            fees[norm((m.group(2) or m.group(1)))] = round(float(amt) * (100 if unit == 'crore' else 1))
    return squads, fees


def parse_sa20():
    text = raw_page('sa20')
    i = text.index('==Squads==')
    squads = squad_table(text[i:], '{| class="wikitable"', team_lookup('sa20'))
    sig = raw_page('sa20-signings')
    fees = {}
    for row in re.split(r'\n\|-', sig[sig.index('== Player auction =='):]):
        m = LINK.search(row)
        num = re.search(r'\n\|\s*([\d,]{6,})', row)
        if m and num:
            fees[norm(m.group(2) or m.group(1))] = int(num.group(1).replace(',', '')) // 1000   # rand thousands
    return squads, fees


HUNDRED_TEAMS = ['Birmingham Phoenix', 'London Spirit', 'Manchester Super Giants', 'MI London', 'Southern Brave',
                 'Sunrisers Leeds', 'Trent Rockets', 'Welsh Fire']
SECTION_ROLE = {'batters': 'BAT', 'all-rounders': 'AR', 'wicket-keepers': 'WK', 'pace bowlers': 'BOWL', 'spin bowlers': 'BOWL'}


HUNDRED_OVERSEAS = set()


def parse_hundred_pages():
    """Each Hundred team's 2026 season page: the men's squad with role (by section), nationality, birth
    date, bowling style, international caps (bold) and notes ("Overseas player", "UK passport")."""
    out = {}
    for team in HUNDRED_TEAMS:
        f = os.path.join(RAW, '2026_' + team.replace(' ', '_') + '_season.wiki')
        if not os.path.exists(f):
            continue
        text = open(f).read()
        # The infobox's overseas list (men's part, after "(women)") includes replacement signings.
        ob = re.search(r'\|\s*overseas\s*=\s*\{\{ubl\|(.*?)\(men\)', text, re.S)
        if ob:
            men = ob.group(1).split('(women)')[-1]
            for m in LINK.finditer(men):
                HUNDRED_OVERSEAS.add(norm((m.group(2) or m.group(1)).strip()))
        mh = re.search(r"=== ?Men's (team|side) ?===", text)
        if not mh:
            continue
        i = mh.start()
        j = text.find('\n==', i + 5)
        section = None
        for line in text[i:j if j > 0 else None].split('\n'):
            h = re.search(r'align=right\|\s*([A-Za-z -]+)', line)
            if line.startswith('!') and h:
                section = SECTION_ROLE.get(h.group(1).strip().lower())
                continue
            if not line.startswith('|style="text-align:center"|'):
                continue
            cells = [c.strip() for c in line.split('||')]
            if len(cells) < 6:
                continue
            m = LINK.search(cells[1])
            name = (m.group(2) or m.group(1)).strip() if m else re.sub(r"'''|\[|\]", '', cells[1]).strip()
            nat = re.search(r'\{\{cr\|([A-Z]+)', cells[2])
            dob = re.search(r'(\d{4})\|(\d{1,2})\|(\d{1,2})', cells[3])
            notes = cells[6] if len(cells) > 6 else ''
            out[norm(name)] = dict(name=name, team=team, role=section, capped="'''" in cells[1],
                                   country=FLAG.get(nat.group(1)) if nat else None,
                                   dob=tuple(int(x) for x in dob.groups()) if dob else None,
                                   bowling=re.sub(r'\[\[[^|\]]*\|([^\]]*)\]\]', r'\1', cells[5]),
                                   overseas='overseas player' in notes.lower())
    return out


def parse_hundred():
    text = raw_page('hundred')
    i = text.index("===Men's===")
    j = text.index('==== Replacements ====', i)
    squads = squad_table(text[i:j], '{| class="wikitable"', team_lookup('hundred'))
    return squads, {}


# ---------- player infoboxes ----------
def infobox_of(txt):
    """The body of the {{Infobox cricketer ...}} template, found by counting braces."""
    m = re.search(r'\{\{\s*Infobox cricketer', txt, re.I)
    if not m:
        return ''
    depth, i = 0, m.start()
    while i < len(txt):
        if txt.startswith('{{', i):
            depth += 1; i += 2; continue
        if txt.startswith('}}', i):
            depth -= 1; i += 2
            if depth == 0:
                return txt[m.end():i - 2]
            continue
        i += 1
    return txt[m.end():]


def fetch_infoboxes(titles, refetch_empty=False):
    cache_f = os.path.join(RAW, 'infoboxes.json')
    cache = json.load(open(cache_f)) if os.path.exists(cache_f) else {}
    todo = [t for t in titles if t and (t not in cache or (refetch_empty and not cache[t]))]
    for k in range(0, len(todo), 40):
        batch = todo[k:k + 40]
        url = ('https://en.wikipedia.org/w/api.php?action=query&format=json&prop=revisions&rvprop=content&rvslots=main&redirects=1&titles='
               + urllib.parse.quote('|'.join(batch)))
        data = json.loads(http(url))
        q = data['query']
        redir = {r['from']: r['to'] for r in q.get('redirects', [])}
        norm_map = {n['from']: n['to'] for n in q.get('normalized', [])}
        pages = {p['title']: p for p in q['pages'].values()}
        for t in batch:
            tt = norm_map.get(t, t)
            tt = redir.get(tt, tt)
            p = pages.get(tt)
            txt = p['revisions'][0]['slots']['main']['*'] if p and 'revisions' in p else ''
            cache[t] = infobox_of(txt)
        json.dump(cache, open(cache_f, 'w'))
        time.sleep(1)
    return cache


def ib_field(ib, key):
    m = re.search(r'\n\s*\|\s*' + key + r'\s*=\s*([^\n]*)', ib)
    if not m:
        return ''
    v = strip_refs(m.group(1))
    v = LINK.sub(lambda x: x.group(2) or x.group(1), v)
    v = re.sub(r'\{\{(?:nowrap|abbr)\|([^|}]*)[^}]*\}\}', r'\1', v)
    return re.sub(r'<[^>]+>|\'\'+', '', v).strip()


# Infoboxes show at most four formats. Test regulars (Rizwan, Root, Smith) often have no T20 column,
# so their one-day numbers stand in for it, adjusted for the format (see features()).
STATS_PREF = {'T20': 0, 'T20S': 0, 'T20I': 1, 'ODI': 2, 'LIST A': 3, 'LA': 3}


def ib_stats(ib):
    """Best available limited-overs career line: T20, then T20I, then ODI, then List A."""
    best, rank = None, 99
    for k in range(1, 5):
        col = ib_field(ib, f'column{k}').upper().replace('ONE DAY INTERNATIONALS', 'ODI').replace('LIST A CRICKET', 'LIST A')
        r = STATS_PREF.get(col)
        if r is None or r >= rank:
            continue
        def num(f):
            v = ib_field(ib, f'{f}{k}').replace(',', '').replace('*', '')
            try:
                return float(v)
            except ValueError:
                return None
        best, rank = dict(col=col, m=num('matches'), runs=num('runs'), avg=num('bat avg'), wk=num('wickets'), bavg=num('bowl avg')), r
    return best


def ib_country(ib):
    c = ib_field(ib, 'country')
    for name in FLAG.values():
        if name.lower() in c.lower():
            return name
    if 'wales' in c.lower():
        return 'England'
    return None


def ib_dob(ib):
    m = re.search(r'\{\{\s*birth date(?: and age)?\s*\|(?:df=\w+\|)?(\d{4})\|(\d{1,2})\|(\d{1,2})', ib, re.I)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def type_from_style(style):
    s = (style or '').lower().replace('-', ' ')
    if not s or 'none' in s:
        return None
    left = 'left' in s
    if 'unorthodox' in s or 'wrist' in s or 'chinaman' in s:
        return 'LWS'
    if 'orthodox' in s or ('left' in s and 'spin' in s):
        return 'SLA'
    if 'leg' in s or 'googly' in s:
        return 'LB'
    if 'off' in s:
        return 'OB'
    if 'medium' in s and 'fast' not in s:
        return 'RM' if not left else 'LFM'
    if left:
        return 'LF' if s.strip().endswith('fast') else 'LFM'
    return 'RF' if s.strip().endswith('fast') else 'RFM'


def role_from(ib, bt, stats):
    r = ib_field(ib, 'role').lower()
    if 'keep' in r:
        return 'WK'
    if 'all' in r:
        return 'AR'
    if 'bowl' in r:
        return 'BOWL'
    if 'bat' in r:
        return 'BAT'
    if stats and stats.get('m'):
        wpm = (stats.get('wk') or 0) / stats['m']
        rpm = (stats.get('runs') or 0) / stats['m']
        if wpm > 0.6 and rpm > 12:
            return 'AR'
        if wpm > 0.5:
            return 'BOWL'
    return 'BAT'


def jitter(name, spread):
    h = int(hashlib.md5(name.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return (h * 2 - 1) * spread


def features(stats):
    """Numbers the rating fit uses. Missing career → zeros (an unknown domestic player)."""
    if not stats or not stats.get('m'):
        return [0, 0, 0, 0, 0]
    m = stats['m']
    oneday = stats['col'] in ('ODI', 'LIST A', 'LA')
    # One-day averages run higher than T20 ones (more time to bat); bowling averages a little lower.
    avg = (stats.get('avg') or 0) * (0.68 if oneday else 1)
    wk = (stats.get('wk') or 0) * (0.85 if oneday else 1)
    bavg = (stats.get('bavg') or 40) * (1.1 if oneday else 1)
    return [math.log1p(m), min(avg, 45), min(wk / m, 1.8), max(0, 36 - min(bavg, 60)) if wk >= 5 else 0, 1]


def fit(rows):
    """Least squares on small dense matrices, no numpy."""
    n = len(rows[0][0])
    A = [[0.0] * n for _ in range(n)]
    b = [0.0] * n
    for x, y in rows:
        for i in range(n):
            b[i] += x[i] * y
            for j in range(n):
                A[i][j] += x[i] * x[j]
    for i in range(n):
        A[i][i] += 1e-3
    # Gaussian elimination
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(A[r][i]))
        A[i], A[p] = A[p], A[i]
        b[i], b[p] = b[p], b[i]
        for r in range(i + 1, n):
            f = A[r][i] / A[i][i]
            for c in range(i, n):
                A[r][c] -= f * A[i][c]
            b[r] -= f * b[i]
    w = [0.0] * n
    for i in reversed(range(n)):
        w[i] = (b[i] - sum(A[i][c] * w[c] for c in range(i + 1, n))) / A[i][i]
    return w


# Each league's fees, converted to the IPL scale, its value scale and its rating offset
# (see js/engine/league.js: rate, valueScale, ratingOffset).
FEE_SCALE = {'psl': (5050 / 12500, 1.75, 6.5), 'sa20': (41000 / 12500, 1.5, 4)}


def fee_rating(lg, fee):
    """The rating a fee implies, by inverting the game's value curve (js/engine/valuation.js)."""
    if fee is None or lg not in FEE_SCALE:
        return None
    rate, scale, offset = FEE_SCALE[lg]
    raw = (fee / rate - 30) / scale
    if raw <= 5:
        return None   # minimum fee: says nothing
    r = 60 + math.log(raw / 24.7) / 0.17 if raw <= 740 else 80 + (raw - 740) / 180
    return max(48, min(90, r - offset))   # back to the underlying (IPL-scale) rating


def fill_archetype(p):
    """A batting archetype by batting position and a bowling specialism by bowling type, for players
    with no known one. Deterministic per player, so rebuilds don't reshuffle them."""
    r = (int(hashlib.md5(('arch:' + p['id']).encode()).hexdigest()[:8], 16) % 1000) / 1000
    if not p.get('bs') and p['role'] in ('BAT', 'WK', 'AR') and p['bat'] >= 45:
        band = (p.get('pos') or ['middle'])[0]
        if band == 'top':
            p['bs'] = 'aggressor' if r < 0.45 else 'anchor' if r < 0.7 else None
        elif band == 'middle':
            p['bs'] = 'spin' if r < 0.2 else 'slogger' if r < 0.38 else 'finisher' if r < 0.52 else 'anchor' if r < 0.64 else None
        elif band == 'lower':
            p['bs'] = 'finisher' if r < 0.45 else 'slogger' if r < 0.75 else None
    if not p.get('br') and p.get('bt') and p['bowl'] >= 66:
        r2 = (r * 7.31) % 1
        if p['bt'] in ('RF', 'RFM', 'RM', 'LF', 'LFM'):
            p['br'] = ['newball'] if r2 < 0.3 else ['death'] if r2 < 0.55 else ['newball', 'death'] if r2 < 0.62 and p['bowl'] >= 74 else []
        elif p['bowl'] >= 72 and r2 < 0.12:
            p['br'] = ['newball']   # the odd spinner who opens the bowling


def overall(role, bat, bowl):
    if role in ('BAT', 'WK'):
        return bat + (2 if role == 'WK' else 0)
    if role == 'BOWL':
        return bowl
    hi, lo = max(bat, bowl), min(bat, bowl)
    return round(max(hi * 0.75 + lo * 0.3, hi + max(0, lo - 30) * 0.1))


def default_bands(role, bat, bowl):
    if role == 'BOWL' or bat < 35:
        return ['tail']
    if role == 'AR':
        return ['middle', 'lower'] if bat >= 65 else ['lower'] if bat >= 45 else ['tail']
    if role == 'WK':
        return ['top', 'middle'] if bat >= 74 else ['middle', 'lower']
    return ['top'] if bat >= 72 else ['middle']


def age_on(dob):
    y, m, d = dob
    return TODAY[0] - y - ((TODAY[1], TODAY[2]) < (m, d))


def main():
    if '--fetch' in sys.argv:
        fetch_pages()
    # Known players: the IPL databases (curated ratings, styles and positions).
    known = {}
    for sid in ('ipl-2025', 'ipl-2026'):
        for p in json.load(open(os.path.join(ROOT, 'data', 'scenarios', sid, 'players.json'))):
            known[norm(p['name'])] = p      # 2026 overwrites 2025
    aliases = {norm(a): norm(b) for a, b in [('Henrich Klaasen', 'Heinrich Klaasen'), ('Hassan Ali', 'Hasan Ali'),
                                              ('Mohammad Rizwan', 'Mohammad Rizwan'), ('Rahmanullah Gurbaz', 'Rahmanullah Gurbaz'),
                                              ('Fazalhaq Farooqi', 'Fazalhaq Farooqi'), ('Will Jacks', 'Will Jacks')]}

    leagues = {'psl': parse_psl(), 'sa20': parse_sa20(), 'hundred': parse_hundred()}
    hpages = parse_hundred_pages()
    # Birth dates already known for IPL players (Wikidata, retained players), for current ages.
    ipl_dob = {}
    try:
        for name, d in json.load(open(os.path.join(ROOT, 'tools', 'raw', 'ipl-2026', 'retained_dob_wikidata.json'))).items():
            ipl_dob[norm(name)] = tuple(int(x) for x in d.rstrip('~').split('-'))
    except (OSError, ValueError):
        pass
    known_ids = {k['id'] for k in known.values()}
    titles = sorted({e['title'] for sq, _ in leagues.values() for es in sq.values() for e in es if e['title']})
    ib = fetch_infoboxes(titles) if '--fetch' in sys.argv or not os.path.exists(os.path.join(RAW, 'infoboxes.json')) else json.load(open(os.path.join(RAW, 'infoboxes.json')))
    if [t for t in titles if t not in ib] or '--refetch-empty' in sys.argv:
        ib = fetch_infoboxes(titles, '--refetch-empty' in sys.argv)

    # Fit ratings: curated bat/bowl of known players against their infobox T20 numbers.
    bat_rows, bowl_rows = [], []
    for t in titles:
        k = known.get(aliases.get(norm(t), norm(re.sub(r'\s*\(.*\)', '', t))))
        st = ib_stats(ib.get(t, ''))
        if k and st and st.get('m'):
            x = features(st)
            if k['role'] in ('BAT', 'WK', 'AR'):
                bat_rows.append((x, k['bat']))
            if k['role'] in ('BOWL', 'AR'):
                bowl_rows.append((x, k['bowl']))
    wbat, wbowl = fit(bat_rows), fit(bowl_rows)
    print(f'rating fit on {len(bat_rows)} batters and {len(bowl_rows)} bowlers')

    players = {}
    contracts = {lg: {} for lg in leagues}
    def add_known(k):
        p = {f: k.get(f) for f in ('id', 'name', 'country', 'role', 'bowlType', 'bat', 'bowl', 'ovr', 'pos', 'bt', 'bs', 'br', 'age', 'capped')}
        p['age'] = k.get('age')
        return p

    for lg, (squads, fees) in leagues.items():
        for tid, entries in squads.items():
            for e in entries:
                key = aliases.get(norm(e['name']), norm(e['name']))
                k = known.get(key)
                hp = hpages.get(norm(e['name'])) if lg == 'hundred' else None
                info = ib.get(e['title'] or '', '')
                dob = (hp and hp['dob']) or ib_dob(info)
                # Same name, different player (e.g. India's and Pakistan's Abdul Samad): different country
                # or a birth date that doesn't fit his age.
                c_here = e['flag'] or (hp and hp['country']) or ib_country(info)
                if k:
                    if dob and k.get('age'):
                        same = abs(age_on(dob) - (k['age'] + 1)) <= 1   # IPL list ages are from Dec 2025
                    else:
                        same = not c_here or c_here == k['country']
                    if not same:
                        k = None
                if k:
                    p = players.get(k['id']) or add_known(k)
                    # Ages now, from a birth date where we have one (the IPL list gives ages at Dec 2025).
                    d = dob or ipl_dob.get(norm(k['name']))
                    p['age'] = age_on(d) if d else (k.get('age') or 26) + 1
                else:
                    st = ib_stats(info)
                    country = e['flag'] or (hp and hp['country']) or ib_country(info) or HOME[lg]
                    bt = type_from_style((hp and hp['bowling']) or ib_field(info, 'bowling'))
                    role = (hp and hp['role']) or role_from(info, bt, st)
                    x = features(st)
                    fee = fees.get(norm(e['name']))
                    # League fee is a second signal: a big buy is a good player even with thin numbers.
                    base = 50 + jitter(e['name'], 3)
                    bat = sum(a * b for a, b in zip(wbat, x)) if st and st.get('m') else base
                    bowl = sum(a * b for a, b in zip(wbowl, x)) if st and st.get('m') else base
                    # One-day numbers flatter accumulators who score slowly in T20: cap what they can imply.
                    if st and st['col'] in ('ODI', 'LIST A', 'LA'):
                        bat = min(bat, 72)
                    # What the club pays is a second opinion on the player's level (PSL and SA20 list fees).
                    implied = fee_rating(lg, fee) if lg != 'psl' or norm(e['name']) in PSL_AUCTION else None
                    if implied is not None:
                        main = 'bat' if role in ('BAT', 'WK') or (role == 'AR' and bat >= bowl) else 'bowl'
                        cur = bat if main == 'bat' else bowl
                        new = 0.55 * cur + 0.45 * implied if st and st.get('m') else implied
                        if main == 'bat': bat = new
                        else: bowl = new
                    if role == 'AR' and min(bat, bowl) < 35:
                        role = 'BAT' if bat > bowl else 'BOWL'
                    if role in ('BAT', 'WK'):
                        bowl = 8 + jitter(e['name'] + 'b', 6) if not bt else min(bowl, 30)
                    elif role == 'BOWL':
                        bat = min(bat, 22 + jitter(e['name'] + 'b', 6))
                    bat, bowl = max(5, min(88, round(bat + jitter(e['name'] + 'x', 2)))), max(5, min(88, round(bowl + jitter(e['name'] + 'y', 2))))
                    pid = slug(e['name'])
                    if any(slug(x['name']) == pid for x in known.values()):
                        pid += '-' + slug(country)   # a different player with an IPL namesake
                    while pid in players and norm(players[pid]['name']) != norm(e['name']):
                        pid += '-2'
                    p = players.get(pid) or dict(id=pid, name=e['name'], country=country, role=role,
                                                 bowlType=('spin' if bt in ('OB', 'LB', 'SLA', 'LWS') else 'pace') if bt else None,
                                                 bat=bat, bowl=bowl, ovr=overall(role, bat, bowl), pos=default_bands(role, bat, bowl),
                                                 bt=bt if bowl >= 40 else None, bs=None, br=[], age=age_on(dob) if dob else 26 + round(jitter(e['name'] + 'a', 4)),
                                                 capped=bool(hp['capped']) if hp else (bool(st and st['col'] == 'T20I') or bool(re.search(r'odi|test|t20i', info, re.I))))
                # Overseas status as the league registers him: a flag in the PSL and SA20 squad tables,
                # the "Overseas player" note on the Hundred team pages (UK passport holders, Scots and
                # Jersey players are local there).
                if lg == 'hundred':
                    local = norm(e['name']) not in HUNDRED_OVERSEAS and not (hp and hp['overseas'])
                else:
                    local = not e['flag']
                p.setdefault('status', {})[lg] = 'local' if local else 'overseas'
                players[p['id']] = p
                price = fees.get(norm(e['name']))
                # Listed in two squads (a Wikipedia slip or a mid-season move): the auction's buyer, else the first.
                other = next((t for t, cs in contracts[lg].items() if any(c['id'] == p['id'] for c in cs)), None)
                if other:
                    if lg == 'psl' and PSL_AUCTION_TEAM.get(norm(e['name'])) == tid:
                        contracts[lg][other] = [c for c in contracts[lg][other] if c['id'] != p['id']]
                    else:
                        continue
                contracts[lg].setdefault(tid, []).append({'id': p['id'], 'price': price})

    # Fees we don't have: a curve on the rating, scaled team by team so each squad spends ~92% of the
    # cap (real squads are built to the cap), never below the league minimum.
    for lg, m in MONEY.items():
        for t, cs in contracts[lg].items():
            unknown = [c for c in cs if c['price'] is None]
            if not unknown:
                continue
            target = m['cap'] * 0.92 - sum(c['price'] for c in cs if c['price'] is not None) - m['min'] * len(unknown)
            shape = {c['id']: math.exp((players[c['id']]['ovr'] - 55) / 8) for c in unknown}
            k = max(0, target) / sum(shape.values())
            for c in unknown:
                c['price'] = int(round((m['min'] + k * shape[c['id']]) / 5) * 5)

    # Hand-checked ratings override the formula (tools/league_ratings.txt).
    for line in open(os.path.join(ROOT, 'tools', 'league_ratings.txt')):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        name, role, bat, bowl = line.split('|')
        for p in players.values():
            if norm(p['name']) == norm(name) and p['id'] not in known_ids:
                p.update(role=role, bat=int(bat), bowl=int(bowl), ovr=overall(role, int(bat), int(bowl)), pos=default_bands(role, int(bat), int(bowl)))

    # Archetypes: hand-checked for well-known players (tools/league_archetypes.txt), then the rest of the
    # players outside the IPL data get one that fits where they bat and what they bowl.
    curated_bs, curated_br, section = {}, {}, None
    for line in open(os.path.join(ROOT, 'tools', 'league_archetypes.txt')):
        line = line.strip()
        if line in ('[batting]', '[bowling]'):
            section = line
            continue
        if not line or line.startswith('#'):
            continue
        name, v = line.split('|')
        (curated_bs if section == '[batting]' else curated_br)[norm(name)] = v if section == '[batting]' else v.split(',')
    found = set()
    for p in players.values():
        n = norm(p['name'])
        if n in curated_bs or n in curated_br:
            found.add(n)   # (IPL players keep the archetypes in the IPL files)
        if n in curated_bs and not p.get('bs'):
            p['bs'] = curated_bs[n]; found.add(n)
        if n in curated_br and not p.get('br'):
            p['br'] = curated_br[n]; found.add(n)
        if p['id'] not in known_ids:
            fill_archetype(p)
    missing = sorted((set(curated_bs) | set(curated_br)) - found)
    if missing:
        print('archetypes for players not in any squad:', ', '.join(missing))

    # IPL: the real 2026 squads (retained + bought at the 2026 auction).
    ipl_players = {p['id']: p for p in json.load(open(os.path.join(ROOT, 'data', 'scenarios', 'ipl-2026', 'players.json')))}
    teams26 = json.load(open(os.path.join(ROOT, 'data', 'scenarios', 'ipl-2026', 'teams.json')))
    actual = json.load(open(os.path.join(ROOT, 'data', 'scenarios', 'ipl-2026', 'actual.json')))
    contracts['ipl'] = {t['id']: [] for t in teams26}
    def known_now(k):
        p = add_known(k)
        d = ipl_dob.get(norm(k['name']))
        p['age'] = age_on(d) if d else (k.get('age') or 26) + 1   # list ages are from Dec 2025
        return p
    for t in teams26:
        for pid in t['retained']:
            p = ipl_players[pid]
            players.setdefault(pid, known_now(p))
            contracts['ipl'][t['id']].append({'id': pid, 'price': p.get('price')})
    for pid, sale in (actual.items() if isinstance(actual, dict) else ((a['id'], a) for a in actual)):
        if sale.get('team'):
            players.setdefault(pid, known_now(ipl_players[pid]))
            contracts['ipl'][sale['team']].append({'id': pid, 'price': sale.get('price')})

    # Coaches
    coaches = {}
    def coach(name, rep):
        cid = slug(name)
        coaches.setdefault(cid, dict(id=cid, name=name, country=COACH_COUNTRY.get(name, ''), rep=rep, jobs={}))
        return coaches[cid]
    for tid, name in IPL_COACHES.items():
        coach(name, COACH_REP[name])['jobs']['ipl'] = tid
    for lg, rows in TEAMS.items():
        for tid, _, _, _, _, _, cname in rows:
            coach(cname, COACH_REP[cname])['jobs'][lg] = tid
    for name, rep in FREE_COACHES.items():
        coach(name, rep)

    teams = {lg: [dict(id=t[0], name=t[1], color=t[3], color2=t[4], home=t[5]) for t in rows] for lg, rows in TEAMS.items()}
    teams['ipl'] = [dict(id=t['id'], name=t['name'], color=t['color'], color2=t['color2'], home=t['home']) for t in teams26]
    champions = {'ipl': ('RCB', 'GT'), 'psl': ('PZ', 'HK'), 'sa20': ('SEC', 'PC'), 'hundred': ('MSG', 'TR')}
    os.makedirs(OUT, exist_ok=True)
    json.dump(dict(date='-'.join(map(str, TODAY)), players=sorted(players.values(), key=lambda p: p['id']), contracts=contracts,
                   coaches=sorted(coaches.values(), key=lambda c: c['id']), teams=teams,
                   champions={lg: dict(year=2026, champion=c, runnerUp=r) for lg, (c, r) in champions.items()}),
              open(os.path.join(OUT, 'world.json'), 'w'), separators=(',', ':'))
    # Checks: Hundred squads against the team pages, and overseas counts per squad.
    for t in HUNDRED_TEAMS:
        tid = team_lookup('hundred')[t]
        mine = {norm(players[c['id']]['name']) for c in contracts['hundred'].get(tid, [])}
        page = {k for k, v in hpages.items() if v['team'] == t}
        if mine != page:
            print('Hundred', tid, 'only in season table:', sorted(mine - page), '| only on team page:', sorted(page - mine))
    for lg in contracts:
        sizes = {t: len(v) for t, v in contracts[lg].items()}
        os_ = {t: sum(1 for c in v if players[c['id']].get('status', {}).get(lg, 'local' if players[c['id']]['country'] == HOME[lg] else 'overseas') == 'overseas') for t, v in contracts[lg].items()}
        print(lg, sizes, 'overseas', os_)
    print(len(players), 'players,', len(coaches), 'coaches')


if __name__ == '__main__':
    main()
