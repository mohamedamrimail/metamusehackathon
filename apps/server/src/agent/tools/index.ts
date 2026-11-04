import calendarBook from './calendar_book.ts';
import calendarList from './calendar_list.ts';
import bookingsList from './bookings_list.ts';
import findOffers from './find_offers.ts';
import findOpportunities from './find_opportunities.ts';
import ordersList from './orders_list.ts';
import prepareCheckout from './prepare_checkout.ts';
import getProfile from './get_profile.ts';
import paperTrade from './paper_trade.ts';
import partnerRequest from './partner_request.ts';
import visitorRequest from './visitor_request.ts';
import placeOrder from './place_order.ts';
import portfolioStatus from './portfolio_status.ts';
import rememberFact from './remember_fact.ts';
import sendEmail from './send_email.ts';
import type { Tool } from './types.ts';
import walletStatus from './wallet_status.ts';
import addRule from './add_rule.ts';
import sendWhatsapp from './send_whatsapp.ts';
import contactsSearch from './contacts_search.ts';
import twinRequest from './twin_request.ts';
import planWithContacts from './plan_with_contacts.ts';
import contactsStatus from './contacts_status.ts';
import inviteContact from './invite_contact.ts';
import connectTwins from './connect_twins.ts';
import findPlaces from './find_places.ts';

export const builtinTools: Tool[] = [
  partnerRequest, visitorRequest, twinRequest, ordersList, bookingsList, findOffers, prepareCheckout, rememberFact, addRule, sendWhatsapp, contactsSearch, contactsStatus, inviteContact, connectTwins, planWithContacts, findPlaces, getProfile, calendarList, calendarBook, sendEmail, findOpportunities,
  placeOrder, walletStatus, paperTrade, portfolioStatus,
] as Tool[];
