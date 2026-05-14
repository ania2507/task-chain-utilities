// Single, stable OData service surface.
// Domain-specific definitions live in srv/domains/* and extend this service.

using from './domains/rules';
using from './domains/taskchains';
using from './domains/monitoring';
using from './domains/schedules';

service Services {}