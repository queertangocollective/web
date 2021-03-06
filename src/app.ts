import * as express from "express";
import QTCSource from "./qtc-source";
import Renderer from "./renderer";
import { html } from "js-beautify";
import { compile } from "handlebars";
import { HIR } from "@atjson/hir";
import * as path from "path";
import * as knex from "knex";
import { Page } from "./annotations";
import Group from "./models/group";
import Person from "./models/person";
import PublishedPost from "./models/published-post";
import Ticket from "./models/ticket";
import * as Stripe from "stripe";
import * as bodyParser from 'body-parser';
import * as Sentry from '@sentry/node';

export default function(db: knex) {
  let app = express();
  Group.db = db;
  Ticket.db = db;
  Person.db = db;
  PublishedPost.db = db;

  app.use(function(req, res, next) {
    if (
      !req.secure &&
      req.headers["x-forwarded-proto"] === "http" &&
      req.path !== "/health"
    ) {
      console.log(`🔒 Securing http://${req.get("host")}`);
      res.redirect(`https://${req.get("host")}${req.url}`);
    } else {
      next();
    }
  });

  app.get("/health", (_req, res) => {
    db.select("id")
      .from("groups")
      .then(
        () => {
          res.send("❤️");
        },
        error => {
          console.error(error);
          res.status(500).send("💔");
        }
      );
  });

  /**
   * POST /pay {
   *   ticketId,
   *   email,
   *   name,
   *   stripeToken
   * }
   */
  app.post("/pay", bodyParser.json(), async function (req, res) {
    if (!req.body) {
      res.sendStatus(400);
      return;
    }

    try {
      let group = await Group.query({ hostname: req.get("host") });
      if (group == null) {
        res.status(400).send("");
        return;
      }
      console.log(`💸️ [${group.hostname}] /pay being processed`);

      let stripe = new Stripe(group.stripeSecretKey);
      let ticket = await Ticket.query({ id: parseInt(req.body.ticketId, 10) });
      if (ticket == null) {
        res.status(400).send("");
        return;
      }

      let charge = await stripe.charges.create({
        amount: ticket.total,
        currency: ticket.currency,
        description: ticket.description,
        receipt_email: req.body.email,
        source: req.body.stripeToken
      });

      if (charge.failure_code || charge.status === 'failed') {
        res.type("json");
        res.status(422);
        res.send({
          status: charge.status,
          failure_code: charge.failure_code,
          failure_message: charge.failure_message
        });
        Sentry.captureMessage(`Charge failed ${charge.failure_code}`);
        return;
      }

      let balance = await stripe.balance.retrieveTransaction(
        charge.balance_transaction.toString()
      );
      
      let paymentUrl = group.stripePublishableKey.indexOf('pk_live') === 0 ?
        `https://dashboard.stripe.com/payments/${charge.id}` :
        `https://dashboard.stripe.com/test/payments/${charge.id}`;

      let person = await Person.query({
        email: req.body.email.toLowerCase()
      });

      if (person == null) {
        person = await Person.create({
          group,
          name: req.body.name,
          email: req.body.email.toLowerCase()
        });
      }

      if (person == null) {
        // This failed, but we shouldn't show this to users,
        // since we charged their card. Instead, alert via Sentry.
        res.status(200).send({
          status: charge.status,
          receipt_url: (charge as any).receipt_url
        });
        Sentry.captureMessage(`Created charge for ${charge.id}, but could not create person.`)
        return;
      }

      // Create transaction, customer, etc in db
      let transaction = await db('transactions').insert({
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        group_id: group.id,
        description: ticket.description,
        ticket_id: ticket.id,
        paid_at: new Date(charge.created * 1000).toISOString(),
        paid_by_id: person.id,
        amount_paid: balance.net,
        currency: balance.currency.toUpperCase(),
        payment_method: 'stripe',
        payment_processor_url: paymentUrl
      }).returning('*');

      for (let i = 0, len = ticket.events.length; i < len; i++) {
        let event = ticket.events[i];
        await db('ticket_stubs').insert({
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          group_id: group!.id,
          person_id: person!.id,
          event_id: event.id,
          purchase_id: transaction[0].id,
          ticket_id: ticket!.id,
          attended: false
        });
      }

      res.type("json");
      res.send({
        status: charge.status,
        receipt_url: (charge as any).receipt_url
      });
    } catch (e) {
      Sentry.captureException(e);
      res.type("json");
      res.status(500);
      res.send({
        failure_message: 'Sorry, something went wrong'
      });
    }
  });

  app.get("/robots.txt", function(req, res) {
    Group.query({ hostname: req.get("host") }).then(
      group => {
        if (group == null) {
          res.status(400).send("");
          return;
        }

        console.log(`ℹ️ [${group.hostname}] Requested robots.txt`);
        res.set("Content-Type", "text/plain");
        res.send(
          `User-agent: *\nSitemap: ${req.protocol}://${
            group.hostname
          }/sitemap.xml`
        );
      },
      function(error: Error) {
        res.send(error);
        console.error(error);
      }
    );
  });

  app.get("/sitemap.xml", function(req, res) {
    Group.query({ hostname: req.get("host") }).then(
      group => {
        if (group == null) {
          res.status(400).send("");
          return;
        }

        console.log(`ℹ️ [${group.hostname}] Requested sitemap.xml`);
        return db
          .select("title", "body", "slug", "updated_at")
          .from("published_posts")
          .where({
            group_id: group.id,
            live: true
          })
          .then((posts: any) => {
            let urls = posts.map((post: any) => {
              // Remove precise time from the url
              let updatedAt = post.updated_at.toISOString();
              let lastmod = updatedAt.slice(0, updatedAt.indexOf("T"));
              return `<url><loc>${req.protocol}://${group.hostname}/${
                post.slug
              }</loc><lastmod>${lastmod}</lastmod></url>`;
            });
            res.set("Content-Type", "text/xml");
            res.send(
              `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join(
                ""
              )}</urlset>`
            );
          });
      },
      function(error: Error) {
        res.send(error);
        console.error(error);
      }
    );
  });

  app.get(
    "/.well-known/apple-developer-merchantid-domain-association",
    function(req, res) {
      Group.query({ hostname: req.get("host") }).then(
        group => {
          if (group == null) {
            res.status(400).send("");
            return;
          }

          console.log(`ℹ️ [${group.hostname}] Sending Apple Pay info`);

          res.set("Content-Type", "text/plain");
          res.send(group.applePayConfiguration);
        },
        function(error) {
          res.status(404).send(error);
          console.error(error);
        }
      );
    }
  );

  app.get("*", async function(req, res) {
    if (req.path === "/home") {
      res.redirect(`${req.protocol}://${req.get("host")}`);
      return;
    }
    let group = await Group.query({ hostname: req.get("host") });
    if (group == null) {
      res.status(400).send("");
      return;
    }

    // Handle any ember apps being hosted
    if (group.build && group.website == null) {
      if (req.path === "/redirect.html") {
        console.log(`ℹ️ [${group.hostname}] Sending Torii /redirect`);
        res.send(
          html(`
        <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <title>Torii OAuth Redirect</title>
              <script>
                var CURRENT_REQUEST_KEY = '__torii_request';
                var pendingRequestKey = window.localStorage.getItem(CURRENT_REQUEST_KEY);
                if (pendingRequestKey) {
                  window.localStorage.removeItem(CURRENT_REQUEST_KEY);
                  var url = window.location.toString();
                  window.localStorage.setItem(pendingRequestKey, url);
                }
                window.close();
              </script>
            </head>
          </html>`)
        );
      } else {
        console.log(
          `ℹ️ [${group.hostname}] Loading app at ${group.build.git_url}commit/${
            group.build.git_sha
          }`
        );
        let build = group.build;
        res.setHeader('cache-control', 'public, max-age=0');
        res.setHeader('last-modified', group.build.live_at.toUTCString());
        res.send(
          html(build.html.replace("%7B%7Bbuild.id%7D%7D", build.id.toString()))
        );
      }
      return;
    }

    if (group.website == null) {
      res.status(400).send("");
      return;
    }

    if (group.website.assets[`public${req.path}`]) {
      let asset = group.website.assets[`public${req.path}`];
      asset = asset.replace(/Stripe\(['|"]pk_test_[a-zA-Z0-9]+['|"]\)/, `Stripe("${group.stripePublishableKey}")`);
      res.setHeader('cache-control', 'public, max-age=0');
      res.setHeader('last-modified', group.website.created_at.toUTCString());
      res.type(path.extname(req.path));
      res.send(asset);
      return;
      // Ignore if no favicon was provided
    } else if (req.path === "favicon.ico") {
      res.status(404).send("Not found");
      return;
    }

    let slug =
      req.path
        .slice(1)
        .replace(/\.json$/, "")
        .replace(/\.html$/, "")
        .replace(/\.hir$/, "") || "home";

    try {
      let isJSON = req.path.match(/\.json$/);
      let isHIR = req.path.match(/\.hir$/);
      console.log(`ℹ️ [${group.hostname}] Loading post /${slug}`);

      let post = await PublishedPost.query({ slug, group }, true);
      if (post == null) {
        console.log(`ℹ️ [${group.hostname}] 404 request to /${slug}`);
        let template = compile(group.website.assets["views/404.hbs"]);
        res.status(404).send(
          html(
            template({
              attrs: {
                locale: group.locale,
                siteName: group.name,
                siteEmail: group.email,
                sections: group.sections
              }
            })
          )
        );
        return;
      }

      let doc = await QTCSource.fromRaw(post);
      let paragraph = [...doc.where({ type: "-offset-paragraph" }).sort()][0];
      let photo = [...doc.where({ type: "-qtc-photo" }).sort()][0];

      doc.addAnnotations(
        new Page({
          start: 0,
          end: doc.content.length,
          attributes: {
            locale: group.locale,
            title: post.title,
            description: paragraph
              ? doc.content.slice(paragraph.start, paragraph.end).trim()
              : null,
            url: `${req.protocol}://${group.hostname}/${slug}`,
            image: photo ? photo.attributes.url : null,
            hasTickets: doc.where({ type: "-qtc-buy-button" }).length > 0,
            section: post.section,
            siteName: group.name,
            siteEmail: group.email,
            sections: group.sections
          }
        })
      );

      res.format({
        "text/html"() {
          if (isJSON) {
            res.type("json");
            res.send(doc.toJSON());
          } else if (isHIR) {
            res.type("json");
            res.send(new HIR(doc).toJSON());
          } else {
            let renderer = new Renderer(group!.website!.assets);
            res.send(
              html(renderer.render(doc), {
                unformatted: ["code", "pre", "em", "strong", "span", "title"],
                indent_inner_html: true,
                indent_char: " ",
                indent_size: 2
              })
            );
          }
        },
        "application/json"() {
          res.send(doc.toJSON());
        }
      });
    } catch (error) {
      console.log(`🚫 [${group.hostname}] Error loading ${slug}`, error);
      let template = compile(group.website.assets["views/404.hbs"]);
      res.status(404).send(
        html(
          template({
            attrs: {
              locale: group.locale,
              siteName: group.name,
              siteEmail: group.email,
              sections: group.sections
            }
          })
        )
      );
    }
  });

  return app;
}
