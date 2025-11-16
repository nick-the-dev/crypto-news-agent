import { RSSSource } from '../types';

export const RSS_SOURCES: RSSSource[] = [
  {
    name: 'DL News',
    url: 'https://www.dlnews.com/arc/outboundfeeds/rss/',
    contentField: 'content:encoded'
  },
  {
    name: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    contentField: 'description'
  },
  {
    name: 'The Defiant',
    url: 'https://thedefiant.io/api/feed',
    contentField: 'content:encoded',
    fallbackField: 'description'
  }
];
