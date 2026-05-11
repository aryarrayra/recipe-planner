function isApiRequest(req) {
    return String(req.originalUrl || req.url || '').startsWith('/api/');
}

function preventBack(req, res, next) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}

function requireAuth(req, res, next) {
    if (!req.session.user) {
        if (isApiRequest(req)) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        return res.redirect('/login');
    }

    next();
}

function requireRole(role) {
    return (req, res, next) => {
        if (!req.session.user) {
            if (isApiRequest(req)) {
                return res.status(401).json({
                    success: false,
                    error: 'Unauthorized'
                });
            }

            return res.redirect('/login');
        }

        if (req.session.user.role !== role) {
            if (isApiRequest(req)) {
                return res.status(403).json({
                    success: false,
                    error: 'Forbidden'
                });
            }

            return res.status(403).send('Forbidden');
        }

        next();
    };
}

module.exports = {
    preventBack,
    requireAuth,
    requireRole
};
