import React from 'react';
import V2Shell from '../V2Shell';
import EmptyState from '../components/EmptyState';

/** `/new/*` preview route: v2 empty state, flagged noindex while mounted. */
const NewPage: React.FC = () => (
  <V2Shell noIndex>
    <EmptyState />
  </V2Shell>
);

export default NewPage;
