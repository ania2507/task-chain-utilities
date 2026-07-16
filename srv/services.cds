// Single, stable OData service surface.
// Domain-specific definitions live in srv/domains/* and extend this service.

using from './domains/rules';
using from './domains/taskchains';
using from './domains/monitoring';
using from './domains/schedules';

// Authorization: the whole OData surface requires the app `admin` scope,
// aligned with the Python backend (`required_scope="admin"`) and the
// `BTP_NOPROD_ORCHESTRATOR_DEV` group mapping. Without it, any authenticated
// user could read/write the underlying tables directly via OData.
@requires: 'admin'
service Services {}