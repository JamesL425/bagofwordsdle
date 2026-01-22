/**
 * EMBEDDLE - UI Text & Copy
 * All user-facing text in one place for easy editing
 * 
 * To use: import { TEXT } from './text.js' or access window.TEXT
 */

const TEXT = {
    // ============ SITE HEADER ============
    site: {
        title: 'EMBEDDLE',
        tagline: '// decode. deduce. eliminate.',
        version: '// EMBEDDLE v1.0',
    },

    // ============ NAVIGATION / TOPBAR ============
    nav: {
        leaderboard: '[LB]',
        replay: '[REC]',
        cosmetics: '[STYLE]',
        games: '[GAME]',
        chat: '[TXT]',
        info: '[INFO]',
        options: '[CFG]',
    },

    // ============ PANEL HEADERS ============
    panels: {
        cosmetics: '// CUSTOMISE',
        options: '// CONFIG',
        info: '// INTEL',
        chat: '// COMMS',
        replay: '// REPLAY',
        leaderboard: '// LEADERBOARDS',
    },

    // ============ HOME SCREEN ============
    home: {
        quickPlay: '> QUICK_PLAY',
        ranked: '> RANKED',
        rankedNote: 'Ranked requires Google sign-in + 5 casual games',
        solo: 'Solo',
        custom: 'Custom',
        joinPlaceholder: 'ENTER CODE HERE',
        join: 'Join',
    },

    // ============ BRIEFING / HOW IT WORKS ============
    briefing: {
        title: '// BRIEFING',
        steps: [
            { action: 'Select', description: 'a codeword from the database' },
            { action: 'Probe', description: 'with guesses to reveal similarity scores' },
            { action: 'Analyse', description: 'patterns while masking your own' },
            { action: 'Execute', description: "when you've identified a target" },
        ],
        footer: 'Sole survivor takes the round.',
    },

    // ============ QUEUE SCREEN ============
    queue: {
        title: '// SCANNING_NETWORK',
        modeLabel: 'MODE:',
        modeQuickPlay: 'STANDARD',
        modeRanked: 'RANKED',
        targetsLabel: 'TARGETS LOCATED:',
        timeLabel: 'TIME IN QUEUE:',
        searchRangeLabel: 'SEARCH RANGE:',
        minPlayersLabel: 'MIN PLAYERS:',
        statusMessage: 'Establishing connection...',
        cancel: '< CANCEL',
    },

    // ============ LOBBY SCREEN ============
    lobby: {
        title: '// SERVER_LOBBY',
        accessCode: 'ACCESS_CODE:',
        copy: 'COPY',
        selectDatabase: 'SELECT DATABASE',
        operatives: 'Operatives:',
        minPlayers: 'Minimum 2 required',
        selectWords: '> SELECT_WORDS',
        disconnect: '< DISCONNECT',
    },

    // ============ SINGLEPLAYER LOBBY ============
    singleplayer: {
        title: '// SOLO_MISSION',
        database: 'DATABASE:',
        selectDatabase: 'SELECT DATABASE',
        operatives: 'OPERATIVES',
        addAI: 'ADD AI OPPONENT',
        minAI: 'Add at least 1 AI target',
        startMission: '> START_MISSION',
        saveExit: '< SAVE & EXIT',
    },

    // ============ AI DIFFICULTIES ============
    ai: {
        rookie: { label: 'ROOKIE', icon: '[R]', desc: 'Wears a wire, drops a clue.' },
        analyst: { label: 'ANALYST', icon: '[A]', desc: 'Careful scans. Minimal self-leak.' },
        fieldAgent: { label: 'FIELD AGENT', icon: '[F]', desc: 'Balanced ops: probes, then strikes.' },
        spymaster: { label: 'SPYMASTER', icon: '[S]', desc: 'Builds a profile. Executes cleanly.' },
        ghost: { label: 'GHOST', icon: '[G]', desc: 'Leaves no trace. Panics into offense.' },
        nemesis: { label: 'NEMESIS', icon: '[N]', desc: 'Cold. Calculated. Relentless.' },
    },

    // ============ WORD SELECTION SCREEN ============
    wordSelect: {
        title: '// SELECT_CODEWORD',
        database: 'DATABASE:',
        lockedIn: 'Locked in:',
        clickWord: 'Click a word above',
        lockIn: '> LOCK_IN',
        locked: '> LOCKED:',
        waiting: 'Awaiting other operatives...',
        initiate: '> INITIATE_BREACH',
    },

    // ============ GAME SCREEN ============
    game: {
        yourWord: 'Your word:',
        round: 'Round ',
        exit: 'EXIT',
        awaitingSignal: 'AWAITING SIGNAL...',
        selectNewWord: '> Select new codeword:',
        selectingWord: 'selecting new word...',
        clickToGuess: 'Click a word to guess',
        guess: 'GUESS',
        confirm: 'CONFIRM',
        keep: 'KEEP',
        history: 'History',
        guessTab: 'GUESS',
        logTab: 'LOG',
    },

    // ============ GAME OVER SCREEN ============
    gameOver: {
        title: 'MISSION COMPLETE',
        playAgain: '> PLAY_AGAIN',
        returnToBase: '< RETURN_TO_BASE',
        rankProgress: 'RANK PROGRESS',
        rankUp: 'RANK UP!',
        copy: 'Copy',
        share: 'Share',
        replay: 'Replay',
        link: 'Link',
        supportPrompt: 'Like the game? Support keeps it running.',
        supportBtn: 'Support on Ko-fi',
    },

    // ============ REPLAY SCREEN ============
    replay: {
        title: '// REPLAY',
        theme: 'Theme:',
        turn: 'Turn',
        prev: '< PREV',
        play: '> PLAY',
        next: 'NEXT >',
        back: '< BACK',
        shareReplay: '// SHARE_REPLAY',
        copyLink: 'COPY LINK',
        copyCode: 'COPY CODE',
        loadPlaceholder: 'Paste replay code...',
        load: 'LOAD',
    },

    // ============ INFO PANEL ============
    info: {
        sourceTitle: '// SOURCE_CODE',
        sourceDesc: 'The code is open source, please help us improve it!',
        viewGithub: 'View on GitHub',
        joinDiscord: 'Join our Discord',
        contributeTitle: '// CONTRIBUTE',
        contributeDesc: 'This is a community project. Get involved:',
        contributeItems: [
            { title: 'Submit PRs', desc: 'patches, features, fixes' },
            { title: 'Report bugs', desc: 'if you find a hole, flag it' },
            { title: 'Add themes', desc: 'expand the word databases' },
            { title: 'Ideas', desc: 'new modes, mechanics, whatever' },
        ],
        techTitle: '// THE_TECH',
        techDesc: 'Words exist as vectors in high-dimensional space. Similar meanings cluster together. We use OpenAI text-embedding-3-large to measure semantic distance.',
        cosineSimilarity: 'Cosine Similarity',
        cosineDesc: 'We measure how "close" two words are using cosine similarity - the cosine of the angle between their vectors. Raw values range from -1 (opposite) to 1 (identical).',
        formula: 'cosine(A, B) = (A · B) / (||A|| × ||B||)',
        displayTitle: 'Display Transformation',
        displayDesc: 'Raw cosine values cluster between 20-60%, making differences hard to read. We apply a sigmoid transform to spread them across 0-100%:',
        transformFormula: 's = x^n / (x^n + (c(1-x))^n), where c = m/(1-m), m = 0.36, n = 3',
        nerdMode: 'Nerd mode (in options) shows the raw cosine similarity alongside the transformed value.',
        modelTitle: 'The Model',
        modelDesc: 'OpenAI text-embedding-3-large - 3072 dimensions, state-of-the-art semantic understanding.',
        rankTitle: '// RANK_TIERS',
        rankDesc: 'Win ranked matches to climb. New operatives calibrate faster due to higher volatility.',
        calibrationTitle: 'Rating Calibration',
        calibrationItems: [
            { phase: 'Placement (0-4 games):', desc: 'High volatility for fast calibration' },
            { phase: 'Provisional (5-19 games):', desc: 'Medium volatility as rating stabilises' },
            { phase: 'Established (20+ games):', desc: 'Normal volatility for stable ratings' },
        ],
        supportTitle: '// SUPPORT',
        supportDesc: 'Free to play. Donations cover server and API costs.',
        supporterPerks: '// SUPPORTER_PERKS',
        supporterPerksDesc: 'Supporters unlock custom theme colours and an exclusive badge. One-time donation, permanent access.',
        supportBtn: '> SUPPORT',
        supportNote: 'Any amount unlocks all supporter perks.',
    },

    // ============ OPTIONS PANEL ============
    options: {
        textChat: 'Text chat',
        music: 'Music',
        sfx: 'SFX',
        turnNotifications: 'Turn notifications',
        nerdMode: 'Nerd mode (show raw cosine similarity)',
    },

    // ============ COSMETICS PANEL ============
    cosmetics: {
        themeColor: '// THEME_COLOUR',
        customHex: '// CUSTOM_HEX',
        apply: '> APPLY',
        badge: '// BADGE',
        title: '// TITLE',
        allUnlocked: '> All customisation unlocked',
        premiumFree: '> Premium features currently free',
        supportToUnlock: '> Support to unlock custom colors',
        supportBtn: '> SUPPORT',
        adminAccess: '> Admin access',
        thanksSupporter: '> Supporter - thank you',
    },

    // ============ PROFILE MODAL ============
    profile: {
        avatarPlaceholder: '[?]',
        editAvatar: '[E]',
        casualStats: '// CASUAL STATS',
        wins: 'Wins',
        games: 'Games',
        winRate: 'Win Rate',
        eliminations: 'Eliminations',
        deaths: 'Deaths',
        bestStreak: 'Best Streak',
        ranked: '// RANKED',
        mmr: 'MMR',
        peak: 'Peak',
        record: 'W-L',
        share: '> SHARE',
        logout: 'LOGOUT',
        chooseAvatar: 'Choose Your Avatar',
    },

    // ============ MODALS ============
    modals: {
        createLobby: '// CREATE_CUSTOM_LOBBY',
        visibility: 'VISIBILITY',
        public: 'PUBLIC',
        private: 'PRIVATE',
        publicHint: 'Anyone can join from Active Servers',
        privateHint: 'Only players with the code can join',
        timeControl: 'TIME CONTROL',
        createLobbyBtn: '> CREATE_LOBBY',
        leaveGame: '// LEAVE_GAME',
        leaveGameText: 'Are you sure? Leaving will forfeit your current match.',
        exit: '> EXIT',
        forfeit: '> FORFEIT',
        cancel: 'CANCEL',
        callsign: '// NAME',
        callsignDesc: 'Pick a unique name for your operative profile. This will be displayed to other players instead of your Google account name.',
        callsignPlaceholder: 'Enter name...',
        callsignRules: '3-20 characters. Letters, numbers, underscores, and hyphens only.',
        confirmCallsign: '> CONFIRM NAME',
        skipForNow: 'Skip for now',
        enterCallsign: '// ENTER_NAME',
        enterCallsignDesc: 'Choose a name to identify yourself in the game.',
        continue: '> CONTINUE',
    },

    // ============ FOOTER ============
    footer: {
        github: 'GitHub',
        discord: 'Discord',
        support: 'Support',
        privacy: 'Privacy',
        terms: 'Terms',
    },

    // ============ ERRORS & NOTIFICATIONS ============
    errors: {
        signInRequired: 'Sign in with Google to customise',
        failedToEquip: 'Failed to equip',
        signInToSave: 'Sign in to save custom colour',
    },

    // ============ MISC ============
    misc: {
        loading: 'Loading...',
        you: 'YOU',
        preview: 'Preview',
        joinMatch: 'Join a match to chat.',
        typeMessage: 'Type message...',
        send: 'SEND',
    },
};

// Make available globally
if (typeof window !== 'undefined') {
    window.TEXT = TEXT;
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TEXT };
}

