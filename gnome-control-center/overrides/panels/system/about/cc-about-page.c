/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*-
 *
 * Copyright (C) 2019 Purism SPC
 * Copyright (C) 2017 Mohammed Sadiq <sadiq@sadiqpk.org>
 * Copyright (C) 2010 Red Hat, Inc
 * Copyright (C) 2008 William Jon McCann <jmccann@redhat.com>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, see <http://www.gnu.org/licenses/>.
 *
 */

#include "cc-about-page.h"
#include "cc-hostname-entry.h"
#include "cc-list-row.h"
#include "cc-system-details-window.h"

#include <config.h>
#include <glib/gi18n.h>
#include <glib/gstdio.h>

struct _CcAboutPage
{
  AdwNavigationPage parent_instance;

  AdwActionRow    *disk_row;
  AdwActionRow    *hardware_model_row;
  AdwActionRow    *memory_row;
  GtkPicture      *os_logo;
  AdwActionRow    *os_name_row;
  AdwActionRow    *processor_row;

  AdwDialog       *system_details_window;
  guint            create_system_details_id;
  GCancellable    *log_cancellable;
};

G_DEFINE_TYPE (CcAboutPage, cc_about_page, ADW_TYPE_NAVIGATION_PAGE)

static void
about_page_setup_overview (CcAboutPage *self)
{
  guint64 ram_size;
  g_autofree char *memory_text = NULL;
  g_autofree char *cpu_text = NULL;
  g_autofree char *os_name_text = NULL;
  g_autofree char *hardware_model_text = NULL;
  g_autofree gchar *disk_capacity_string = NULL;

  hardware_model_text = get_hardware_model_string ();
  adw_action_row_set_subtitle (self->hardware_model_row, hardware_model_text);
  gtk_widget_set_visible (GTK_WIDGET (self->hardware_model_row), hardware_model_text != NULL);

  ram_size = get_ram_size_dmi ();
  if (ram_size == 0)
    ram_size = get_ram_size_libgtop ();
  memory_text = g_format_size_full (ram_size, G_FORMAT_SIZE_IEC_UNITS);
  adw_action_row_set_subtitle (self->memory_row, memory_text);

  cpu_text = get_cpu_info ();
  adw_action_row_set_subtitle (self->processor_row, cpu_text);

  disk_capacity_string = get_primary_disk_info ();
  if (disk_capacity_string == NULL)
    disk_capacity_string = g_strdup (_("Unknown"));
  adw_action_row_set_subtitle (self->disk_row, disk_capacity_string);

  os_name_text = get_os_name ();
  adw_action_row_set_subtitle (self->os_name_row, os_name_text);
}

static gboolean
cc_about_page_create_system_details (CcAboutPage *self)
{
  if (!self->system_details_window)
    {
      self->system_details_window = ADW_DIALOG (cc_system_details_window_new ());
      g_object_ref_sink (self->system_details_window);
    }

  g_clear_handle_id (&self->create_system_details_id, g_source_remove);

  return G_SOURCE_REMOVE;
}

static void
cc_about_page_open_system_details (CcAboutPage *self)
{
  cc_about_page_create_system_details (self);

  adw_dialog_present (self->system_details_window, GTK_WIDGET (self));
}

/* ── Surface GO: System log download ─────────────────────────── */

typedef struct {
  CcAboutPage *page;
  char        *filepath;
  char        *filename;
} LogSaveData;

static void
log_save_data_free (LogSaveData *data)
{
  g_clear_object (&data->page);
  g_free (data->filepath);
  g_free (data->filename);
  g_free (data);
}

static void
on_log_save_finished (GObject      *source,
                      GAsyncResult *result,
                      gpointer      user_data)
{
  LogSaveData *data = user_data;
  g_autoptr(GError) error = NULL;
  GSubprocess *proc = G_SUBPROCESS (source);
  AdwDialog *dialog;

  if (!g_subprocess_wait_check_finish (proc, result, &error))
    {
      /* Cancelled — page was disposed, don't try to show dialog */
      if (g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED))
        {
          log_save_data_free (data);
          return;
        }

      g_autofree char *body = g_strdup_printf (
          _("Log collection failed: %s"), error->message);
      dialog = adw_alert_dialog_new (_("Error"), body);
    }
  else
    {
      g_autofree char *body = g_strdup_printf (
          _("Logs saved to ~/Downloads/%s"), data->filename);
      dialog = adw_alert_dialog_new (_("Logs Saved"), body);
    }

  adw_alert_dialog_add_response (ADW_ALERT_DIALOG (dialog), "ok", _("OK"));
  adw_dialog_present (dialog, GTK_WIDGET (data->page));
  log_save_data_free (data);
}

static void
cc_about_page_download_logs (CcAboutPage *self)
{
  g_autoptr(GDateTime) now = NULL;
  g_autofree char *timestamp = NULL;
  g_autofree char *downloads_dir = NULL;
  g_autofree char *cmd = NULL;
  g_autofree char *quoted_path = NULL;
  g_autoptr(GError) error = NULL;
  g_autoptr(GSubprocess) proc = NULL;
  LogSaveData *data;

  /* Cancel any in-progress log collection */
  if (self->log_cancellable)
    {
      g_cancellable_cancel (self->log_cancellable);
      g_clear_object (&self->log_cancellable);
    }

  now = g_date_time_new_now_local ();
  timestamp = g_date_time_format (now, "%Y%m%d_%H%M%S");

  data = g_new0 (LogSaveData, 1);
  data->page = g_object_ref (self);
  data->filename = g_strdup_printf ("system-log-%s.txt", timestamp);
  downloads_dir = g_build_filename (g_get_home_dir (), "Downloads", NULL);
  data->filepath = g_build_filename (downloads_dir, data->filename, NULL);

  g_mkdir_with_parents (downloads_dir, 0755);

  quoted_path = g_shell_quote (data->filepath);
  cmd = g_strdup_printf (
      "{ "
      "echo '=== 系统信息 ==='; uname -a; echo; "
      "echo '=== 硬件型号 ==='; "
      "cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null; "
      "cat /sys/devices/virtual/dmi/id/bios_version 2>/dev/null; echo; "
      "echo '=== 内存 ==='; free -h; echo; "
      "echo '=== 磁盘 ==='; df -h /; echo; "
      "echo '=== 显卡 ==='; "
      "lspci -nn 2>/dev/null | grep -i vga; echo; "
      "echo '=== GNOME Shell ==='; "
      "gnome-shell --version 2>/dev/null; echo; "
      "echo '=== 已修改的包 ==='; "
      "dpkg -l gnome-shell gnome-control-center gnome-settings-daemon 2>/dev/null "
      "| grep -E '^ii'; echo; "
      "echo '=== dconf (gnome-shell) ==='; "
      "dconf dump /org/gnome/shell/ 2>/dev/null; echo; "
      "echo '=== dconf (mutter) ==='; "
      "dconf dump /org/gnome/mutter/ 2>/dev/null; echo; "
      "echo '=== 系统日志 (本次启动, 最近 5000 行) ==='; "
      "journalctl --boot --no-pager -o short-precise -n 5000; "
      "} > %s 2>&1",
      quoted_path);

  proc = g_subprocess_new (G_SUBPROCESS_FLAGS_NONE,
                           &error,
                           "sh", "-c", cmd, NULL);

  if (proc == NULL)
    {
      g_warning ("Failed to spawn log collector: %s", error->message);
      log_save_data_free (data);
      return;
    }

  self->log_cancellable = g_cancellable_new ();
  g_subprocess_wait_check_async (proc, self->log_cancellable, on_log_save_finished, data);
}

#if !defined(DISTRIBUTOR_LOGO) || defined(DARK_MODE_DISTRIBUTOR_LOGO)
static gboolean
use_dark_theme (CcAboutPage *self)
{
  AdwStyleManager *style_manager = adw_style_manager_get_default ();

  return adw_style_manager_get_dark (style_manager);
}
#endif

static void
setup_os_logo (CcAboutPage *self)
{
#ifdef DISTRIBUTOR_LOGO
#ifdef DARK_MODE_DISTRIBUTOR_LOGO
  if (use_dark_theme (self))
    {
      gtk_picture_set_filename (self->os_logo, DARK_MODE_DISTRIBUTOR_LOGO);
      return;
    }
#endif
  gtk_picture_set_filename (self->os_logo, DISTRIBUTOR_LOGO);
  return;
#else
  GtkIconTheme *icon_theme;
  g_autofree char *logo_name = g_get_os_info ("LOGO");
  g_autoptr(GtkIconPaintable) icon_paintable = NULL;
  g_autoptr(GPtrArray) array = NULL;
  g_autoptr(GIcon) icon = NULL;
  gboolean dark;

  dark = use_dark_theme (self);
  if (logo_name == NULL)
    logo_name = g_strdup ("gnome-logo");

  array = g_ptr_array_new_with_free_func (g_free);
  if (dark)
    g_ptr_array_add (array, (gpointer) g_strdup_printf ("%s-text-dark", logo_name));
  g_ptr_array_add (array, (gpointer) g_strdup_printf ("%s-text", logo_name));
  if (dark)
    g_ptr_array_add (array, (gpointer) g_strdup_printf ("%s-dark", logo_name));
  g_ptr_array_add (array, (gpointer) g_strdup_printf ("%s", logo_name));

  icon = g_themed_icon_new_from_names ((char **) array->pdata, array->len);
  icon_theme = gtk_icon_theme_get_for_display (gdk_display_get_default ());
  icon_paintable = gtk_icon_theme_lookup_by_gicon (icon_theme, icon,
                                                   192,
                                                   gtk_widget_get_scale_factor (GTK_WIDGET (self)),
                                                   gtk_widget_get_direction (GTK_WIDGET (self)),
                                                   0);
  gtk_picture_set_paintable (self->os_logo, GDK_PAINTABLE (icon_paintable));
#endif
}

static void
cc_about_page_dispose (GObject *object)
{
  CcAboutPage *self = CC_ABOUT_PAGE (object);

  if (self->system_details_window)
    adw_dialog_force_close (self->system_details_window);
  g_clear_object (&self->system_details_window);

  if (self->log_cancellable)
    g_cancellable_cancel (self->log_cancellable);
  g_clear_object (&self->log_cancellable);

  g_clear_handle_id (&self->create_system_details_id, g_source_remove);

  G_OBJECT_CLASS (cc_about_page_parent_class)->dispose (object);
}

static void
cc_about_page_class_init (CcAboutPageClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);
  GtkWidgetClass *widget_class = GTK_WIDGET_CLASS (klass);

  object_class->dispose = cc_about_page_dispose;

  g_type_ensure (CC_TYPE_HOSTNAME_ENTRY);

  gtk_widget_class_set_template_from_resource (widget_class, "/org/gnome/control-center/system/about/cc-about-page.ui");

  gtk_widget_class_bind_template_child (widget_class, CcAboutPage, disk_row);
  gtk_widget_class_bind_template_child (widget_class, CcAboutPage, hardware_model_row);
  gtk_widget_class_bind_template_child (widget_class, CcAboutPage, memory_row);
  gtk_widget_class_bind_template_child (widget_class, CcAboutPage, os_logo);
  gtk_widget_class_bind_template_child (widget_class, CcAboutPage, os_name_row);
  gtk_widget_class_bind_template_child (widget_class, CcAboutPage, processor_row);

  gtk_widget_class_bind_template_callback (widget_class, cc_about_page_open_system_details);
  gtk_widget_class_bind_template_callback (widget_class, cc_about_page_download_logs);
}

static void
cc_about_page_init (CcAboutPage *self)
{
  AdwStyleManager *style_manager;

  gtk_widget_init_template (GTK_WIDGET (self));

  about_page_setup_overview (self);

  style_manager = adw_style_manager_get_default ();
  g_signal_connect_object (style_manager, "notify::dark", G_CALLBACK (setup_os_logo), self, G_CONNECT_SWAPPED);
  setup_os_logo (self);

  self->create_system_details_id = g_idle_add (G_SOURCE_FUNC (cc_about_page_create_system_details), self);
}
